import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/dist-types/**', 'coverage/**', '**/*.tsbuildinfo'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.lint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // El `any` implicito ya lo prohibe `strict` en tsconfig; esta cubre el
      // explicito, que es por donde se cuela lo que llega sin tipos (JSON,
      // WebAudio, APIs del navegador que los tipos del DOM no describen bien).
      '@typescript-eslint/no-explicit-any': 'error',
      // `noUncheckedIndexedAccess` esta encendido, asi que `a[i]` es
      // `T | undefined` en todas partes. El `!` es la contrapartida obligada de
      // esa eleccion (buffers circulares, nodos del grafo de navegacion), no un
      // atajo: prohibirlo aqui seria castigar la comprobacion mas estricta.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Interpolar un numero en una plantilla es exactamente lo que se quiere en
      // los mensajes de log y del HUD.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // `() => hacerAlgo()` en un callback no confunde a nadie.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      // Codigo muerto: nada "para mas adelante". El guion bajo es la valvula de
      // escape para lo que la firma obliga a declarar pero no se usa.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['apps/client/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['apps/server/**/*.ts', 'packages/shared/**/*.ts', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // La propia configuracion del linter no esta en `tsconfig.lint.json`, asi
    // que las reglas que necesitan tipos no pueden mirarla.
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
