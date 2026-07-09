declare module 'imagetracerjs' {
  export type ImageTracerOptions = Record<string, unknown>;

  const ImageTracer: {
    imagedataToSVG(imageData: ImageData, options?: ImageTracerOptions | string): string;
    imagedataToTracedata(imageData: ImageData, options?: ImageTracerOptions | string): unknown;
  };

  export default ImageTracer;
}
