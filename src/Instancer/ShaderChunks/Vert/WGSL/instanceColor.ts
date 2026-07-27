export default `

    var uInstancerColorTexture: texture_2d<f32>;

    fn getInstanceColor() -> vec4f {
        let id = i32(getInstanceId());
        let size = i32(textureDimensions(uInstancerColorTexture, 0).x);
        let x = id % size;
        let y = id / size;
        return textureLoad(uInstancerColorTexture, vec2<i32>(x, y), 0);
    }
`;