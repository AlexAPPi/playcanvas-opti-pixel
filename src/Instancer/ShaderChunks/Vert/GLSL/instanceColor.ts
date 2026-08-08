export default `

    #ifdef INSTANCER_USE_LAYERS
        uniform highp sampler2DArray uInstancerColorTexture;
    #else
        uniform highp sampler2D uInstancerColorTexture;
    #endif

    vec4 getInstanceColor() {

        int id = int(getInstanceId());
        int size = textureSize(uInstancerColorTexture, 0).x;
        int x = id % size;
        int y = id / size;

        #ifdef INSTANCER_USE_LAYERS
            int layer = int(getInstanceLayer());
            ivec3 coord = ivec3(x, y, layer);
        #else
            ivec2 coord = ivec2(x, y);
        #endif

        return texelFetch(uInstancerColorTexture, coord, 0);
    }
`;