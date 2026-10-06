import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const src = new URL('./src', import.meta.url).pathname

/* One script and one stylesheet, at fixed names, with no HTML entry: the shell
   is injected into documents Helmo's own servers already render, so the server
   has to be able to name the files without reading a manifest. */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: [{ find: /^@\//, replacement: `${src}/` }] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: `${src}/main.tsx`,
      output: {
        entryFileNames: 'shell.js',
        chunkFileNames: 'shell-[name].js',
        assetFileNames: (asset) => (asset.names?.[0]?.endsWith('.css') ? 'shell.css' : '[name][extname]'),
      },
    },
  },
})
