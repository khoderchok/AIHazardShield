const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const generatedNativeBuilds = [
  /android[\/\\]build[\/\\].*/,
  /android[\/\\]app[\/\\]build[\/\\].*/,
  /node_modules[\/\\].*[\/\\]android[\/\\].*[\/\\]build[\/\\].*/,
];

const existingBlockList = config.resolver.blockList;

config.resolver.blockList = Array.isArray(existingBlockList)
  ? [...existingBlockList, ...generatedNativeBuilds]
  : existingBlockList
    ? [existingBlockList, ...generatedNativeBuilds]
    : generatedNativeBuilds;

module.exports = config;

// File summary:
// metro.config.js customizes the Expo Metro bundler.
// It starts from Expo's default Metro configuration.
// It blocks generated Android build folders so Metro does not scan noisy native outputs.
// The React Native app uses this during local development and bundling.
