export default `

    precision highp float;

    attribute uint aBoundingBoxIndex;

    flat out uint out_flags;

    uniform mat4 uMatrixViewProjection;
    uniform vec2 uScreenSize;
    uniform vec2 uHZBSize;

    #include "getBoundingBoxVS"
    #include "cullBoundingBoxVS"
    #include "getFlagsVS"

    void main(void) {

        float instanceDepth;
        float hzbDepth;
        vec2 minCoord;
        vec2 maxCoord;

        vec2 boundingBoxExtra;
        vec3 boundingBoxCenter;
        vec3 boundingBoxHalfExtents;

        getBoundingBox(aBoundingBoxIndex, boundingBoxCenter, boundingBoxHalfExtents, boundingBoxExtra);

        int cullStatus = cullBoundingBox(
            boundingBoxCenter, boundingBoxHalfExtents,
            instanceDepth, hzbDepth,
            minCoord, maxCoord
        );

        out_flags = getFlags(
            aBoundingBoxIndex, boundingBoxCenter, boundingBoxHalfExtents, boundingBoxExtra,
            instanceDepth, hzbDepth, cullStatus,
            minCoord, maxCoord
        );
    }
`;