const ethers = require('ethers')
const fetch = require('node-fetch')
const { BitlyClient } = require('bitly')
const level = require('level')
const Twitter = require('twitter-lite')

const _GTCRFactory = require('@kleros/tcr/build/contracts/GTCRFactory.json')
const _GeneralizedTCR = require('@kleros/tcr/build/contracts/GeneralizedTCR.json')
const _GeneralizedTCRView = require('@kleros/tcr/build/contracts/GeneralizedTCRView.json')

const { requestSubmittedHandler } = require('./handlers')

const {
  utils: { formatEther }
} = ethers

const bitly = new BitlyClient(process.env.BITLY_TOKEN, {})
const db = level('./db')
const twitterClient = new Twitter({
  consumer_key: process.env.CONSUMER_KEY,
  consumer_secret: process.env.CONSUMER_SECRET,
  access_token: process.env.ACCESS_TOKEN,
  access_token_secret: process.env.ACCESS_TOKEN_SECRET
})

// Run env variable checks.
require('./utils/env-check')

const provider = new ethers.providers.JsonRpcProvider(process.env.PROVIDER_URL)
provider.pollingInterval = 5 * 60 * 1000 // Poll every 5 minutes.

const gtcrFactory = new ethers.Contract(
  process.env.FACTORY_ADDRESS,
  _GTCRFactory.abi,
  provider
)

const gtcrView = new ethers.Contract(
  process.env.GENERALIZED_TCR_VIEW_ADDRESS,
  _GeneralizedTCRView.abi,
  provider
)

;(async () => {
  // Initial setup.
  console.info('Booting...')
  const [currBlock, network] = await Promise.all([
    provider.getBlockNumber('latest'),
    provider.getNetwork()
  ])
  const deploymentBlock = Number(process.env.FACTORY_BLOCK_NUM) || 0

  // Fetch logs by scanning the blockchain in batches of 4 months
  // to avoid rate-limiting.
  const blocksPerMinute = Math.floor(
    60 / (process.env.BLOCK_TIME_MILLISECONDS / 1000)
  )
  const blocksPerRequest = blocksPerMinute * 60 * 24 * 30 * 4

  // Fetch the addresses of TCRs deployed with this factory.
  const logPromises = []
  for (let fromBlock = deploymentBlock; ; ) {
    logPromises.push(
      provider.getLogs({
        ...gtcrFactory.filters.NewGTCR(),
        fromBlock: fromBlock,
        toBlock: fromBlock + blocksPerRequest
      })
    )

    if (fromBlock + blocksPerRequest >= currBlock) break
    fromBlock += blocksPerRequest
  }

  // Concat results and instantiate TCRs.
  const tcrs = (await Promise.all(logPromises))
    .reduce((acc, curr) => acc.concat(curr), [])
    .map(log => gtcrFactory.interface.parseLog(log).values._address)
    .map(address => new ethers.Contract(address, _GeneralizedTCR.abi, provider))

  // Fetch latest metadata for every tcr.
  console.info('Fetching TCR meta evidence...')
  const tcrMetaEvidences = (
    await Promise.all(
      tcrs.map(async tcr => {
        const logs = (
          await provider.getLogs({
            ...tcr.filters.MetaEvidence(),
            fromBlock: deploymentBlock
          })
        ).map(log => tcr.interface.parseLog(log))
        const { _evidence: metaEvidencePath } = logs[logs.length - 1].values
        const file = await (
          await fetch(process.env.IPFS_GATEWAY + metaEvidencePath)
        ).json()

        // We use a max length limit of item name and TCR title to avoid
        // reaching twitter's char limit.
        const itemName =
          file.metadata.itemName.length > 7 ? 'item' : file.metadata.itemName
        const tcrTitle =
          file.metadata.tcrTitle.length > 11 ? 'a TCR' : file.metadata.tcrTitle
        return {
          tcrAddress: tcr.address,
          file: { ...file, itemName, tcrTitle }
        }
      })
    )
  ).reduce((acc, curr) => ({ ...acc, [curr.tcrAddress]: curr.file }), {})
  console.info('Done.')

  console.info('Fetching TCR contract information...')
  const tcrArbitrableDatas = (
    await Promise.all(
      tcrs.map(async tcr => ({
        tcrAddress: tcr.address,
        data: await gtcrView.fetchArbitrable(tcr.address)
      }))
    )
  )
    .map(arbitrableData => ({
      tcrAddress: arbitrableData.tcrAddress,
      data: {
        ...arbitrableData.data,
        formattedEthValues: {
          // Format wei values to ETH.
          submissionBaseDeposit: formatEther(
            arbitrableData.data.submissionBaseDeposit
          ),
          removalBaseDeposit: formatEther(
            arbitrableData.data.removalBaseDeposit
          ),
          submissionChallengeBaseDeposit: formatEther(
            arbitrableData.data.submissionChallengeBaseDeposit
          ),
          removalChallengeBaseDeposit: formatEther(
            arbitrableData.data.removalChallengeBaseDeposit
          )
        }
      }
    }))
    .reduce((acc, curr) => ({ ...acc, [curr.tcrAddress]: curr.data }), {})
  console.info('Done.')

  // Add listeners for events emitted by the TCRs.
  for (const tcr of tcrs) {
    tcr.on(
      tcr.filters.RequestSubmitted(),
      requestSubmittedHandler({
        tcr,
        tcrMetaEvidence: tcrMetaEvidences[tcr.address],
        tcrArbitrableData: tcrArbitrableDatas[tcr.address],
        twitterClient,
        bitly,
        db,
        network
      })
    )

    tcr.on(
      tcr.filters.Dispute(),
      (_arbitrator, _disputeID, _metaEvidenceID, _evidenceGroupID) => {
        // TODO: Fetch reference to tweet in db add reply.
        // TODO: Tweet about item challenged
        // TODO: Add arbitrator listeners for
        // - AppealPossible
        // - AppealDecision
      }
    )

    tcr.on(
      tcr.filters.ItemStatusChange(),
      (_itemID, _requestIndex, _roundIndex, _disputed, _resolved) => {
        // eslint-disable-next-line no-useless-return
        if (_disputed || !_resolved) return // Only handle final status changes.

        // TODO: Fetch reference to tweet in db add reply.
        // TODO: Tweet about request executed without challenges.
      }
    )

    tcr.on(tcr.filters.Ruling(), (_arbitrator, _disputeID, _ruling) => {
      // TODO: Fetch reference to tweet in db add reply.
      // TODO: Tweet about final ruling.
    })

    tcr.on(
      tcr.filters.Evidence(),
      (_arbitrator, _evidenceGroupID, _party, _evidence) => {
        // TODO: Fetch reference to tweet in db add reply.
        // TODO: Tweet aboout new evidence.
      }
    )
  }
})()
