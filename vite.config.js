import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 纯前端项目：无代理、无后端（见 docs/PRD.md 第 75 行）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
})
