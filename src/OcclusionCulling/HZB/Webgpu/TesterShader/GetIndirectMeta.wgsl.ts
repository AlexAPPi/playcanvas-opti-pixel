export default `

    struct IndirectMetaData {
        indexCount: u32,
        firstIndex: u32,
        baseVertex: i32,
        firstInstance: u32
    }

    fn getIndirectMetaData(itemIndex: u32) -> IndirectMetaData {

        let index = i32(itemIndex * uniforms.metaDataPixelsSizePerInstance);
        let width = i32(textureDimensions(indirectMetaData).x);

        let v = index / width;
        let u = index % width;

        let data = textureLoad(indirectMetaData, vec2<i32>(u, v), 0);
        var indr: IndirectMetaData;

        // TODO: available for indexed
        indr.indexCount    = data.x;
        indr.firstIndex    = data.y;
        indr.baseVertex    = i32(data.z);
        indr.firstInstance = data.w;

        return indr;
    }
`;