export default `

    #ifdef INSTANCER_USE_LAYERS
        var uInstancerColorTexture: texture_2d_array<f32>;
    #else
        var uInstancerColorTexture: texture_2d<f32>;
    #endif

    fn getInstanceColor() -> vec4f {

        let id = i32(getInstanceId());
        let size = i32(textureDimensions(uInstancerColorTexture, 0).x);
        let x = id % size;
        let y = id / size;

        #ifdef INSTANCER_USE_LAYERS
            let layer = i32(getInstanceLayer());
            return textureLoad(uInstancerColorTexture, vec2<i32>(x, y), layer, 0);
        #else
            return textureLoad(uInstancerColorTexture, vec2<i32>(x, y), 0);
        #endif
    }
`;
