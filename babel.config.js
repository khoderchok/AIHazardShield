module.exports = function(api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: ["react-native-reanimated/plugin"],
  };
};

// File summary:
// babel.config.js configures Babel for the Expo React Native project.
// It enables the Expo preset used to transform app JavaScript.
// It includes the React Native Reanimated plugin required for animated UI code.
// Metro reads this file when bundling the mobile app.
