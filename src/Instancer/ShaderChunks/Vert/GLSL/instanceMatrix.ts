export default `

    #ifdef INSTANCER_USE_LAYERS
        uniform highp sampler2DArray uInstancerMatricesTexture;
    #else
        uniform highp sampler2D uInstancerMatricesTexture;
    #endif

    mat4 getInstanceMatrix() {

        int id = int(getInstanceId());
        int size = textureSize(uInstancerMatricesTexture, 0).x;
        int j = id * 4;
        int x = j % size;
        int y = j / size;

        #ifdef INSTANCER_USE_LAYERS
            int layer = int(getInstanceLayer());
            ivec3 coord1 = ivec3(x, y, layer);
            ivec3 coord2 = coord1 + ivec3(1, 0, 0);
            ivec3 coord3 = coord1 + ivec3(2, 0, 0);
            ivec3 coord4 = coord1 + ivec3(3, 0, 0);
        #else
            ivec2 coord1 = ivec2(x, y);
            ivec2 coord2 = coord1 + ivec2(1, 0);
            ivec2 coord3 = coord1 + ivec2(2, 0);
            ivec2 coord4 = coord1 + ivec2(3, 0);
        #endif

        vec4 v1 = texelFetch(uInstancerMatricesTexture, coord1, 0);
        vec4 v2 = texelFetch(uInstancerMatricesTexture, coord2, 0);
        vec4 v3 = texelFetch(uInstancerMatricesTexture, coord3, 0);
        vec4 v4 = texelFetch(uInstancerMatricesTexture, coord4, 0);
        return mat4(v1, v2, v3, v4);
    }
`;