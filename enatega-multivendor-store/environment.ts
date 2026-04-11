/*****************************
 * environment.js
 * path: '/environment.js' (root of your project)
 ******************************/

import * as Updates from "expo-updates";
import { useContext } from "react";
import { ConfigurationContext } from "./lib/context/global/configuration.context";

const PROD_GRAPHQL_URL = "https://aws-server-v2.enatega.com/graphql";
const PROD_WS_GRAPHQL_URL = "wss://aws-server-v2.enatega.com/graphql";
const DEV_GRAPHQL_URL = "http://localhost:8001/graphql";
const DEV_WS_GRAPHQL_URL = "ws://localhost:8001/graphql";

const getEnvVars = (env = Updates.channel) => {
  const configuration = useContext(ConfigurationContext);
  void configuration;

  if (env === "production" || env === "staging") {
    return {
      GRAPHQL_URL: process.env.EXPO_PUBLIC_PROD_GRAPHQL_URL ?? PROD_GRAPHQL_URL,
      WS_GRAPHQL_URL:
        process.env.EXPO_PUBLIC_PROD_WS_GRAPHQL_URL ?? PROD_WS_GRAPHQL_URL,
    };
  }
  return {
    GRAPHQL_URL: process.env.EXPO_PUBLIC_GRAPHQL_URL ?? DEV_GRAPHQL_URL,
    WS_GRAPHQL_URL: process.env.EXPO_PUBLIC_WS_GRAPHQL_URL ?? DEV_WS_GRAPHQL_URL,
  };
};

export default getEnvVars;
