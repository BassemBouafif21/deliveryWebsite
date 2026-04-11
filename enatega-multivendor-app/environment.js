// /*****************************
//  * environment.js
//  * path: '/environment.js' (root of your project)
//  ******************************/

import { useContext } from 'react'
import ConfigurationContext from './src/context/Configuration'
import * as Updates from 'expo-updates'

const PROD_GRAPHQL_URL = 'https://aws-server-v2.enatega.com/graphql'
const PROD_WS_GRAPHQL_URL = 'wss://aws-server-v2.enatega.com/graphql'
const PROD_REST_URL = 'https://aws-server-v2.enatega.com/'
const DEV_GRAPHQL_URL = 'http://localhost:8001/graphql'
const DEV_WS_GRAPHQL_URL = 'ws://localhost:8001/graphql'
const DEV_REST_URL = 'http://localhost:8001/'

const useEnvVars = (env = Updates.channel) => {
  const configuration = useContext(ConfigurationContext)

  const commonConfig = {
    IOS_CLIENT_ID_GOOGLE: configuration?.iOSClientID,
    ANDROID_CLIENT_ID_GOOGLE: configuration?.androidClientID,
    AMPLITUDE_API_KEY: configuration?.appAmplitudeApiKey,
    GOOGLE_MAPS_KEY: configuration?.googleApiKey,
    EXPO_CLIENT_ID: configuration?.expoClientID,
    SENTRY_DSN:
      configuration?.customerAppSentryUrl ??
      'https://4213c02977911e1b75898c93cc5517fb@o1103026.ingest.us.sentry.io/4508662470803456',
    TERMS_AND_CONDITIONS: configuration?.termsAndConditions,
    PRIVACY_POLICY: configuration?.privacyPolicy,
    TEST_OTP: configuration?.testOtp,
    GOOGLE_PACES_API_BASE_URL: configuration?.googlePlacesApiBaseUrl
  }

  if (env === 'production' || env === 'staging') {
    return {
      GRAPHQL_URL: process.env.EXPO_PUBLIC_PROD_GRAPHQL_URL ?? PROD_GRAPHQL_URL,
      WS_GRAPHQL_URL: process.env.EXPO_PUBLIC_PROD_WS_GRAPHQL_URL ?? PROD_WS_GRAPHQL_URL,
      SERVER_URL: process.env.EXPO_PUBLIC_PROD_GRAPHQL_URL ?? PROD_GRAPHQL_URL,
      SERVER_REST_URL: process.env.EXPO_PUBLIC_PROD_SERVER_REST_URL ?? PROD_REST_URL,
      ...commonConfig
    }
  }

  return {
    GRAPHQL_URL: process.env.EXPO_PUBLIC_GRAPHQL_URL ?? DEV_GRAPHQL_URL,
    WS_GRAPHQL_URL: process.env.EXPO_PUBLIC_WS_GRAPHQL_URL ?? DEV_WS_GRAPHQL_URL,
    SERVER_URL: process.env.EXPO_PUBLIC_GRAPHQL_URL ?? DEV_GRAPHQL_URL,
    SERVER_REST_URL: process.env.EXPO_PUBLIC_SERVER_REST_URL ?? DEV_REST_URL,
    ...commonConfig
  }
}

export default useEnvVars
