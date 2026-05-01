import pc from "../engine";

export type TArrayConstructor = Float32ArrayConstructor | Uint32ArrayConstructor | Uint16ArrayConstructor | Uint8ArrayConstructor;

export class GPUBufferTool {

    public static update(vertexBuffer: pc.VertexBuffer | null, data: Uint32Array | Uint16Array | Uint8Array, length: number): void {

        // TODO: playcanvas buffer always 4 byte safe

        if (vertexBuffer) {

            const device = vertexBuffer.device;

            if (device.isWebGL2) {
                const gl = (device as pc.WebglGraphicsDevice).gl;
                const type = gl.ARRAY_BUFFER;
                gl.bindBuffer(type, vertexBuffer.impl.bufferId);
                gl.bufferSubData(type, 0, data, 0, length);
                gl.bindBuffer(type, null);
            }
            else if (device.isWebGPU) {

                const wgpu   = (device as any).wgpu as GPUDevice;
                const buffer = vertexBuffer.impl.buffer as GPUBuffer;

                const byteLength = length * data.BYTES_PER_ELEMENT;
                const paddedLength = Math.ceil(byteLength / 4) * 4;

                wgpu.queue.writeBuffer(buffer, 0, data.buffer, 0, paddedLength);
            }
            else {
                console.error('Unsupported device');
            }
        }
    }

    public static updateOfTexture(texture: pc.Texture | null, data: Uint32Array<ArrayBuffer> | Uint16Array<ArrayBuffer> | Uint8Array<ArrayBuffer>, length: number, normalize: boolean = true): void {

        if (texture) {

            const unDevice = texture.device;
            const width = Math.min(length, texture.width);
            const height = Math.ceil(length / width);

            if (unDevice.isWebGL2) {

                // TODO: Webgl upload full fusted that sub update
                // USE: GPUBufferTool.uploadOfTexture(texture, data, length, normalize);

                const device = unDevice as pc.WebglGraphicsDevice;
                const gl = device.gl;
                const glFormat = texture.impl._glFormat;
                const glPixelType = texture.impl._glPixelType;

                device.setTexture(texture, 0);
                device.setUnpackFlipY(false);
                device.setUnpackPremultiplyAlpha(texture.premultiplyAlpha);

                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, glFormat, glPixelType, data);
            }
            else if (unDevice.isWebGPU) {

                const wgpu = (unDevice as any).wgpu as GPUDevice;
                const wgpuTexture = texture.impl.gpuTexture as GPUTexture;
                const formatInfo = pc.pixelFormatInfo.get(texture.format);
                const bytesPerRowUnaligned = width * formatInfo!.size!;
                const bytesPerRow = Math.ceil(bytesPerRowUnaligned / 256) * 256; // bytesPerRow must be multiple of 256

                let alignedData = data;
                
                if (normalize) {

                    const requiredBufferSize = bytesPerRow * height;
                    const proxy = new Uint8Array(data.buffer);

                    alignedData = new Uint8Array(requiredBufferSize);

                    for (let row = 0; row < height; row++) {

                        const srcStart  = row * bytesPerRowUnaligned;
                        const destStart = row * bytesPerRow;

                        for (let i = 0; i < bytesPerRowUnaligned; i++) {
                            alignedData[destStart + i] = proxy[srcStart + i];
                        }
                    }
                }
                
                wgpu.queue.writeTexture(
                    { texture: wgpuTexture },
                    alignedData,
                    { offset: 0, bytesPerRow: bytesPerRow, rowsPerImage: height },
                    { width: width, height: height, depthOrArrayLayers: 1 }
                );
            }
            else {
                console.error('Unsupported device');
            }
        }
    }

    public static uploadOfTexture(texture: pc.Texture | null, data: Uint32Array<ArrayBuffer> | Uint16Array<ArrayBuffer> | Uint8Array<ArrayBuffer>, length: number, normalize: boolean = true): void {

        if (texture) {

            const unDevice = texture.device;

            if (unDevice.isWebGL2) {

                const device = unDevice as pc.WebglGraphicsDevice;
                const gl = device.gl;
                const impl = texture.impl;
                const size = Math.ceil(length / texture.width) * texture.width;

                // Ensure the GL texture object exists and is bound.
                device.setTexture(texture, 0);
                device.activeTexture(0);
                device.bindTexture(texture);

                device.setUnpackFlipY(false);
                device.setUnpackPremultiplyAlpha(false);
                device.setUnpackAlignment(data.BYTES_PER_ELEMENT);

                // Wrap the source TypedArray to match the texture's pixel type when needed
                // (e.g. RGBA8UI expects UNSIGNED_BYTE → Uint8Array, even if the caller passes Uint32Array).
                let src = data;
                if (impl._glPixelType === gl.UNSIGNED_BYTE && data.BYTES_PER_ELEMENT !== 1) {
                    const byteSize = size * data.BYTES_PER_ELEMENT;
                    src = new Uint8Array(data.buffer, data.byteOffset, byteSize);
                }

                // Full-buffer upload (texImage2D allocates fresh storage each call).
                gl.texImage2D(
                    gl.TEXTURE_2D, 0, impl._glInternalFormat,
                    texture.width, texture.height, 0,
                    impl._glFormat, impl._glPixelType, src
                );

                // Keep engine texture state consistent: storage exists now.
                impl._glCreated = true;
            }
            else {
                console.error('Unsupported device');
            }
        }
    }
}