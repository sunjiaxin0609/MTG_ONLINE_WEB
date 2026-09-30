import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    server: {
      deps: {
        // node:sqlite 是 Node 内置模块，需要从 vite 的依赖预构建/转换中排除
        external: ['node:sqlite'],
      },
    },
  },
});