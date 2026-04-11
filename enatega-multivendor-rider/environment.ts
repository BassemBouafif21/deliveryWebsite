import { loadDevMessages, loadErrorMessages } from "@apollo/client/dev";
import * as Updates from "expo-updates";
import { useContext } from "react";
import { ConfigurationContext } from "./lib/context/global/configuration.context";

const PROD_GRAPHQL_URL = "https://aws-server-v2.enatega.com/graphql";
const PROD_WS_GRAPHQL_URL = "wss://aws-server-v2.enatega.com/graphql";
const DEV_GRAPHQL_URL = "http://localhost:8001/graphql";
const DEV_WS_GRAPHQL_URL = "ws://localhost:8001/graphql";

const getEnvVars = (env = Updates.channel) => {
  const configuration = useContext(ConfigurationContext);
  if (__DEV__) {
    loadDevMessages();
    loadErrorMessages();
  }
  if (!__DEV__) {
    return {
      GRAPHQL_URL: process.env.EXPO_PUBLIC_PROD_GRAPHQL_URL ?? PROD_GRAPHQL_URL,
      WS_GRAPHQL_URL:
        process.env.EXPO_PUBLIC_PROD_WS_GRAPHQL_URL ?? PROD_WS_GRAPHQL_URL,
      SENTRY_DSN:
        configuration?.riderAppSentryUrl ??
        "https://e963731ba0f84e5d823a2bbe2968ea4d@o1103026.ingest.sentry.io/6135261",
      // GOOGLE_MAPS_KEY: 'AIzaSyBk4tvTtPaSEAVSvaao2yISz4m8Q-BeE1M',
      GOOGLE_MAPS_KEY: configuration?.googleApiKey,
      ENVIRONMENT: "production",
    };
  }

  return {
    GRAPHQL_URL: process.env.EXPO_PUBLIC_GRAPHQL_URL ?? DEV_GRAPHQL_URL,
    WS_GRAPHQL_URL: process.env.EXPO_PUBLIC_WS_GRAPHQL_URL ?? DEV_WS_GRAPHQL_URL,
    SENTRY_DSN:
      configuration?.riderAppSentryUrl ??
      "https://e963731ba0f84e5d823a2bbe2968ea4d@o1103026.ingest.sentry.io/6135261",
    // GOOGLE_MAPS_KEY: 'AIzaSyBk4tvTtPaSEAVSvaao2yISz4m8Q-BeE1M',
    GOOGLE_MAPS_KEY: configuration?.googleApiKey,
    ENVIRONMENT: "development",
  };
};

export default getEnvVars;
