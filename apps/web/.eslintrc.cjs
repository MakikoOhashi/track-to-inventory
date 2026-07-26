/**
 * ESLint for React Router 7 + TypeScript (replaces deprecated @remix-run/eslint-config).
 * Based on the Remix v2 template streamlined config.
 */

/** @type {import('@types/eslint').Linter.Config} */
module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: {
      jsx: true,
    },
  },
  env: {
    browser: true,
    commonjs: true,
    es6: true,
  },
  globals: {
    shopify: "readonly",
  },
  ignorePatterns: ["!**/.server", "!**/.client"],
  extends: ["eslint:recommended", "prettier"],
  rules: {
    "no-empty": "warn",
    "no-useless-escape": "warn",
    "prefer-const": "off",
    "no-irregular-whitespace": "warn",
  },
  overrides: [
    {
      files: ["**/*.{js,jsx,ts,tsx}"],
      plugins: ["react"],
      extends: [
        "plugin:react/recommended",
        "plugin:react/jsx-runtime",
        "plugin:react-hooks/recommended",
      ],
      settings: {
        react: {
          version: "detect",
        },
        formComponents: ["Form"],
        linkComponents: [
          { name: "Link", linkAttribute: "to" },
          { name: "NavLink", linkAttribute: "to" },
        ],
        "import/resolver": {
          typescript: {
            project: "./tsconfig.json",
          },
        },
      },
      rules: {
        "react/prop-types": "off",
        "react/no-unescaped-entities": "warn",
        "react/jsx-key": "warn",
      },
    },
    {
      files: ["**/*.{ts,tsx}"],
      plugins: ["@typescript-eslint", "import"],
      parser: require.resolve("@typescript-eslint/parser"),
      settings: {
        "import/internal-regex": "^~/",
        "import/parsers": {
          [require.resolve("@typescript-eslint/parser")]: [".ts", ".tsx"],
        },
        "import/resolver": {
          node: {
            extensions: [".ts", ".tsx"],
          },
          typescript: {
            project: "./tsconfig.json",
            alwaysTryTypes: true,
          },
        },
      },
      extends: [
        "plugin:@typescript-eslint/recommended",
        "plugin:import/recommended",
        "plugin:import/typescript",
      ],
      rules: {
        "no-unused-vars": "off",
        "no-dupe-class-members": "off",
        "no-undef": "off",
        "@typescript-eslint/ban-ts-comment": "off",
        "@typescript-eslint/no-empty-function": "off",
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-unused-vars": [
          "error",
          { args: "none", ignoreRestSiblings: true },
        ],
        "@typescript-eslint/consistent-type-imports": "warn",
      },
    },
    {
      files: [
        "**/routes/**/*.{js,jsx,ts,tsx}",
        "**/app/root.{js,jsx,ts,tsx}",
      ],
      rules: {
        "react/display-name": "off",
      },
    },
    {
      files: ["**/*.{js,jsx}"],
      env: {
        node: true,
      },
      rules: {
        "no-unused-vars": [
          "warn",
          { args: "none", ignoreRestSiblings: true },
        ],
        "no-empty": "warn",
      },
    },
    {
      files: [
        ".eslintrc.cjs",
        "**/workers/**/*.{js,ts}",
        "**/server.js",
      ],
      env: {
        node: true,
      },
    },
  ],
};
