export default `

    #ifdef INSTANCER_USE_LAYERS
        var uInstancerMatricesTexture: texture_2d_array<f32>;
    #else
        var uInstancerMatricesTexture: texture_2d<f32>;
    #endif

    fn getInstanceMatrix() -> mat4x4f {

        let id = i32(getInstanceId());
        let size = i32(textureDimensions(uInstancerMatricesTexture, 0).x);
        let j = id * 4;
        let x = j % size;
        let y = j / size;

        #ifdef INSTANCER_USE_LAYERS
            let layer = i32(getInstanceLayer());
            let v1 = textureLoad(uInstancerMatricesTexture, vec2<i32>(x, y), layer, 0);
            let v2 = textureLoad(uInstancerMatricesTexture, vec2<i32>(x + 1, y), layer, 0);
            let v3 = textureLoad(uInstancerMatricesTexture, vec2<i32>(x + 2, y), layer, 0);
            let v4 = textureLoad(uInstancerMatricesTexture, vec2<i32>(x + 3, y), layer, 0);
        #else
            let v1 = textureLoad(uInstancerMatricesTexture, vec2<i32>(x, y), 0);
            let v2 = textureLoad(uInstancerMatricesTexture, vec2<i32>(x + 1, y), 0);
            let v3 = textureLoad(uInstancerMatricesTexture, vec2<i32>(x + 2, y), 0);
            let v4 = textureLoad(uInstancerMatricesTexture, vec2<i32>(x + 3, y), 0);
        #endif

        return mat4x4f(v1, v2, v3, v4);
    }
`;
