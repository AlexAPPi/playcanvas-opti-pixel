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

        vec3 boundingBoxCenter;
        vec3 boundingBoxHalfExtents;

        getBoundingBox(aBoundingBoxIndex, boundingBoxCenter, boundingBoxHalfExtents);

        int cullStatus = cullBoundingBox(boundingBoxCenter, boundingBoxHalfExtents, uMatrixViewProjection, uScreenSize, uHZBSize, instanceDepth, hzbDepth);

        out_flags = getFlags(
            aBoundingBoxIndex, boundingBoxCenter, boundingBoxHalfExtents, uMatrixViewProjection, 
            instanceDepth, hzbDepth, cullStatus
        );
    }
`;