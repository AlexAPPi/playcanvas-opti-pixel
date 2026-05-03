export default `

    // Examples: a (0..2), b (0..8)
    uint pack0to2and0to8(uint a, uint b) {
        a = a & 0x3u;
        b = b & 0xFu;
        return a | (b << 2u);
    }

    // a (0..2)
    uint packCullStatusValue(uint a) {
        return a & 0x3u;
    }

    uint getFlags(
        uint index, vec3 boxCenterWorld, vec3 boxHalfExtends, mat4 viewProjection,
        float instanceDepth, float hzbDepth, int cullStatus
    ) {
        // Here we can wrap the output flag and return some other data,
        // for example, calculate the LOD for boxCenterWorld or any
        // cullStatus (0 - visible, 1 - occluded, 2 - outside frustum)

        uint cullStatusU = uint(cullStatus);
        return packCullStatusValue(cullStatusU);

        /*
        uint someValue0to8 = 5u;
        return pack0to2and0to8(cullStatusU, someValue0to8);
        */
    }
`;