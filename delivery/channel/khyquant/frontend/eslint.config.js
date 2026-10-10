/**
 * @pattern Visitor
 */
import pluginVue from 'eslint-plugin-vue'

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      // TS SFC: the lint toolchain has no typescript-eslint, so a lang="ts"
      // SFC always dies with a Parsing error here. Re-include once TS lint
      // deps (@vue/eslint-config-typescript) are added.
      'src/components/MobileToast.vue',
    ],
  },
  {
    files: ['**/*.{js,jsx,cjs,mjs,vue}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: { vue: pluginVue },
    rules: {
      'vue/no-unused-vars': 'warn',
      'vue/return-in-computed-property': 'warn',
      'vue/no-side-effects-in-computed-properties': 'warn',
    },
  },
  ...pluginVue.configs['flat/recommended'],
  {
    // Single-word names (Login/Dashboard/Trading...) are the convention for
    // route pages; the multi-word rule targets reusable components only.
    // Must come AFTER the recommended spread: later flat-config entries win.
    files: ['src/views/**/*.vue'],
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },
];
