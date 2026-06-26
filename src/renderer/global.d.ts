import type { VentaApi } from '../preload/index'

declare global {
  interface Window {
    venta: VentaApi
  }
}

export {}
