export default `

    struct BoundingBox {
        center: vec3<f32>,
        halfExtents: vec3<f32>,
        extra: vec2<f32>
    }

    fn getBoundingBox(itemIndex: u32) -> BoundingBox {

        let index = i32(itemIndex * uniforms.boundingBoxPixelsSizePerInstance);
        let width = i32(textureDimensions(boundingBoxes).x);

        let v = index / width;
        let u = index % width;

        var box: BoundingBox;

        let data1 = textureLoad(boundingBoxes, vec2<i32>(u    , v), 0);
        let data2 = textureLoad(boundingBoxes, vec2<i32>(u + 1, v), 0);

        box.center      = data1.xyz;
        box.halfExtents = data2.xyz;
        box.extra       = vec2<f32>(data1.w, data2.w);

        return box;
    }
`;