export default `

    struct BoundingBox {
        center: vec3<f32>,
        halfExtents: vec3<f32>
    }

    fn getBoundingBox(itemIndex: u32) -> BoundingBox {

        let index = i32(itemIndex * uniforms.boundingBoxPixelsSizePerInstance);
        let width = i32(textureDimensions(boundingBoxes).x);

        let v = index / width;
        let u = index % width;

        var box: BoundingBox;

        box.center      = textureLoad(boundingBoxes, vec2<i32>(u + 0, v), 0).xyz;
        box.halfExtents = textureLoad(boundingBoxes, vec2<i32>(u + 1, v), 0).xyz;

        return box;
    }
`;