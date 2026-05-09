export default `

    attribute uint aBoundingBoxIndex;

    flat out uint out_flags;

    uniform mat4 uMatrixViewProjection;
    uniform vec3 uHZBUvFactor;
    uniform vec2 uScreenSize;
    uniform vec2 uHZBSize;

    #include "getBoundingBoxVS"
    #include "cullBoundingBoxVS"
    #include "getFlagsVS"

    void main(void) {

        vec3 rectMin;
        vec3 rectMax;

        vec2 boundingBoxExtra;
        vec3 boundingBoxCenter;
        vec3 boundingBoxHalfExtents;

        getBoundingBox(aBoundingBoxIndex, boundingBoxCenter, boundingBoxHalfExtents, boundingBoxExtra);

        int cullStatus = cullBoundingBox(
            boundingBoxCenter, boundingBoxHalfExtents,
            rectMin, rectMax
        );

        out_flags = getFlags(
            aBoundingBoxIndex, boundingBoxCenter, boundingBoxHalfExtents, boundingBoxExtra,
            rectMin, rectMax, cullStatus
        );
    }
`;