declare module 'html5-qrcode' {
  export class Html5Qrcode {
    constructor(elementId: string)
    scanFile(imageFile: File, showImage?: boolean): Promise<string>
    clear(): Promise<void>
  }
}
