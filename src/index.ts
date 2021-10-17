import * as msRestNodeAuth from '@azure/ms-rest-nodeauth'
import {
  AzureMediaServices,
  AzureMediaServicesModels,
  Mediaservices
} from '@azure/arm-mediaservices'
import {
  AzureMediaServicesOptions,
  IPRange,
  LiveEvent,
  LiveEventInputAccessControl,
  LiveEventPreview,
  LiveOutput,
  MediaservicesGetResponse
} from '@azure/arm-mediaservices/esm/models'

import * as readlineSync from 'readline-sync'
import { v4 as uuidv4 } from 'uuid'

import * as dotenv from 'dotenv'
dotenv.config()

let mediaServicesClient: AzureMediaServices

const clientId: string = process.env.AADCLIENTID as string
const secret: string = process.env.AADSECRET as string
const tenantDomain: string = process.env.AADTENANTDOMAIN as string
const subscriptionId: string = process.env.SUBSCRIPTIONID as string
const resourceGroup: string = process.env.RESOURCEGROUP as string
const accountName: string = process.env.ACCOUNTNAME as string

let credentials: msRestNodeAuth.ApplicationTokenCredentials

export async function main() {
  let uniqueness = uuidv4().split('-')[0]
  let liveEventName = `liveEvent-${uniqueness}`
  let assetName = `archiveAsset${uniqueness}`
  let liveOutputName = `liveOutput${uniqueness}`
  let streamingLocatorName = `liveStreamLocator${uniqueness}`
  let streamingEndpointName = 'default'
  let mediaAccount: MediaservicesGetResponse

  let liveEvent: LiveEvent
  let liveOutput: LiveOutput

  let clientOptions: AzureMediaServicesOptions = {
    longRunningOperationRetryTimeout: 5
  }

  try {
    credentials = await msRestNodeAuth.loginWithServicePrincipalSecret(clientId, secret, tenantDomain)
    mediaServicesClient = new AzureMediaServices(credentials, subscriptionId, clientOptions)
  } catch (err) {
    console.error(`Error retrieving Media Services Client. Status Code:${err.statusCode}`)
    return { error: err }
  }

  mediaAccount = await mediaServicesClient.mediaservices.get(resourceGroup, accountName)
  try {
    let output = {
      ingestUrl: null,
      previewEndpoint: null,
      streamingEndpoint: null,
      hslManifest: null,
      dashManifest: null
    }

    let allowAllInputRange: IPRange = {
      name: 'AllowAll',
      address: '0.0.0.0',
      subnetPrefixLength: 0
    }
    let liveEventInputAccess: LiveEventInputAccessControl = {
      ip: {
        allow: [allowAllInputRange]
      }
    }

    let liveEventPreview: LiveEventPreview = {
      accessControl: {
        ip: {
          allow: [allowAllInputRange]
        }
      }
    }

    let liveEventCreate: LiveEvent = {
      location: mediaAccount.location,
      description: 'Futudent Live event',
      useStaticHostname: true,
      input: {
        streamingProtocol: 'RTMP',
        accessControl: liveEventInputAccess,
        // Use this value when you want to make sure the ingest URL is static
        // and always the same. If omitted, the service will generate a random
        // GUID value.
        accessToken: '9eb1f703b149417c8448771867f48501'
      },
      encoding: {
        encodingType: 'None',
      },
      preview: liveEventPreview,
      streamOptions: ['LowLatency']
    }

    let liveCreateOperation = await mediaServicesClient.liveEvents.beginCreate(
      resourceGroup,
      accountName,
      liveEventName,
      liveEventCreate,
      { autoStart: false }
    )

    console.log('HTTP Response Status:', ${liveCreateOperation.getInitialResponse().status})

    if (!liveCreateOperation.isFinished()) {
      await liveCreateOperation.pollUntilFinished()
    }

    console.log('Creating an asset named:', ${assetName})
    let asset = await mediaServicesClient.assets.createOrUpdate(resourceGroup, accountName, assetName, {})
    let manifestName: string = 'output'
    console.log('Creating a live output named:', ${liveOutputName})

    let liveOutputCreate: LiveOutput;
    if (asset.name) {
      liveOutputCreate = {
        description: 'Futudent streaming service',
        assetName: asset.name,
        manifestName: manifestName,
        archiveWindowLength: 'PT1H',
        hls: { fragmentsPerTsSegment: 1 }
      }

      let liveOutputOperation = await mediaServicesClient.liveOutputs.beginCreate(
        resourceGroup,
        accountName,
        liveEventName,
        liveOutputName,
        liveOutputCreate
      )
    }

    console.log(`Starting the Live Event operation... please stand by`);
    let liveEventStartOperation = await mediaServicesClient.liveEvents.beginStart(
      resourceGroup,
      accountName,
      liveEventName
    )
    let response = await liveEventStartOperation.pollUntilFinished()
    let liveEvent = await mediaServicesClient.liveEvents.get(
      resourceGroup,
      accountName,
      liveEventName
    )

    if (liveEvent.input?.endpoints) {
      let ingestUrl = liveEvent.input.endpoints[0].url
      console.log('RTMP ingest:', ${ingestUrl})
      output.ingestUrl = ingestUrl
    }

    if (liveEvent.preview?.endpoints) {
      let previewEndpoint = liveEvent.preview.endpoints[0].url
      console.log('Preview URL:', previewEndpoint)
      // https://ampdemo.azureedge.net/?url=${previewEndpoint}(format=mpd-time-cmaf)&heuristicprofile=lowlatency
      output.previewEndpoint = previewEndpoint
    }

    // IMPORTANT TIP!: Make CERTAIN that the video is flowing to the Preview URL before continuing!

    let locator = await createStreamingLocator(assetName, streamingLocatorName)
    let streamingEndpoint = await mediaServicesClient.streamingEndpoints.get(resourceGroup, accountName, streamingEndpointName)
    if (streamingEndpoint?.resourceState !== 'Running') {
      await mediaServicesClient.streamingEndpoints.start(resourceGroup, accountName, streamingEndpointName)
    }

    let hostname = streamingEndpoint.hostName
    let scheme = 'https'

    let manifests = await buildManifestPaths(scheme, hostname, locator.streamingLocatorId, manifestName)

    return output
  } catch (err) {
    console.error(err)
    return { error: err }
  }
  finally {
    //@ts-ignore - these will be set, so avoiding the compiler complaint for now.
    await cleanUpResources(liveEventName, liveOutputName)
  }
}

main().catch((err) => {
  console.error('Error running live streaming:', err.message)
  return { error: err }
});

// --- --- ---
async function buildManifestPaths(scheme: string, hostname: string | undefined, streamingLocatorId: string |undefined, manifestName: string) {
  const hlsFormat: string = 'format=m3u8-cmaf'
  const dashFormat: string = 'format=mpd-time-cmaf'

  // for HLS compliant player (HLS.js, Shaka, ExoPlayer), iOS device
  let manifestBase = `${scheme}://${hostname}/${streamingLocatorId}/${manifestName}.ism/manifest`
  let hlsManifest = `${manifestBase}(${hlsFormat})`

  // for Azure Media Player, https://ampdemo.azureedge.net/?url=${dashManifest}&heuristicprofile=lowlatency
  let dashManifest = `${manifestBase}(${dashFormat})`
  return {
    hlsManifest: hlsManifest,
    dashManifest: dashManifest
  }
}

async function createStreamingLocator(assetName: string, locatorName: string) {
  let streamingLocator = {
    assetName: assetName,
    streamingPolicyName: 'Predefined_ClearStreamingOnly'
  }

  let locator = await mediaServicesClient.streamingLocators.create(
    resourceGroup,
    accountName,
    locatorName,
    streamingLocator
  )

  return locator
}

async function cleanUpResources(liveEventName: string, liveOutputName: string) {
  let liveOutputForCleanup = await mediaServicesClient.liveOutputs.get(
    resourceGroup,
    accountName,
    liveEventName,
    liveOutputName
  )

  if (liveOutputForCleanup) {
    let deleteOperation = await mediaServicesClient.liveOutputs.beginDeleteMethod(
      resourceGroup,
      accountName,
      liveEventName,
      liveOutputName
    )

    await deleteOperation.pollUntilFinished()
  }

  let liveEventForCleanup = await mediaServicesClient.liveEvents.get(
    resourceGroup,
    accountName,
    liveEventName
  )

  if (liveEventForCleanup) {
    if (liveEventForCleanup.resourceState == 'Running') {
      let stopOperation = await mediaServicesClient.liveEvents.beginStop(
        resourceGroup,
        accountName,
        liveEventName,
        {
          //removeOutputsOnStop: true
        }
      )

      await stopOperation.pollUntilFinished()
    }

    let deleteLiveEventOperation = await mediaServicesClient.liveEvents.beginDeleteMethod(
      resourceGroup,
      accountName,
      liveEventName
    )
    await deleteLiveEventOperation.pollUntilFinished();
  }
}
