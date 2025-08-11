import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/yu/', // ← GitHub 리포 이름으로 교체
  plugins: [react()],
})