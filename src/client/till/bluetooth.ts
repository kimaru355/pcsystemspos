/*
 * Direct ESC/POS printing over Web Bluetooth (Chrome on Android and desktop). The browser asks the
 * person to pick the printer once per page session; the connection is then reused.
 */

// The services cheap 58/80mm Bluetooth LE printers expose.
const PRINTER_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
]

type Characteristic = {
  properties: { write: boolean; writeWithoutResponse: boolean }
  writeValue(v: BufferSource): Promise<void>
  writeValueWithoutResponse?(v: BufferSource): Promise<void>
}
type Bluetooth = {
  requestDevice(o: unknown): Promise<{
    name?: string
    gatt?: {
      connected: boolean
      connect(): Promise<{
        getPrimaryServices(): Promise<{ getCharacteristics(): Promise<Characteristic[]> }[]>
      }>
    }
  }>
}

function bluetooth(): Bluetooth | null {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator ? (navigator as unknown as { bluetooth: Bluetooth }).bluetooth : null
}

export function canPrintBluetooth(): boolean {
  return bluetooth() !== null
}

let printer: { name: string; characteristic: Characteristic } | null = null

async function connect(): Promise<{ name: string; characteristic: Characteristic }> {
  const bt = bluetooth()
  if (!bt) throw new Error('This browser cannot print over Bluetooth. Use Print, SMS or email.')
  const device = await bt.requestDevice({ acceptAllDevices: true, optionalServices: PRINTER_SERVICES })
  const server = await device.gatt?.connect()
  if (!server) throw new Error('The printer did not connect.')
  for (const service of await server.getPrimaryServices()) {
    for (const c of await service.getCharacteristics()) {
      if (c.properties.write || c.properties.writeWithoutResponse) {
        return { name: device.name ?? 'Printer', characteristic: c }
      }
    }
  }
  throw new Error('That device is not a printer this till knows.')
}

/** Print ESC/POS bytes, asking for a printer the first time. */
export async function printBluetooth(bytes: Uint8Array): Promise<string> {
  printer ??= await connect()
  const c = printer.characteristic
  try {
    for (let i = 0; i < bytes.length; i += 180) {
      const chunk = bytes.slice(i, i + 180)
      if (c.properties.writeWithoutResponse && c.writeValueWithoutResponse) await c.writeValueWithoutResponse(chunk)
      else await c.writeValue(chunk)
    }
  } catch (e) {
    printer = null // reconnect next time
    throw e
  }
  return printer.name
}
