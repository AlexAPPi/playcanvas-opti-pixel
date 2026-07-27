export default `

    uniform highp sampler2D uInstancerColorTexture;

    vec4 getInstanceColor() {
        int id = int(getInstanceId());
        int size = textureSize(uInstancerColorTexture, 0).x;
        int x = id % size;
        int y = id / size;
        return texelFetch(uInstancerColorTexture, ivec2(x, y), 0);
    }
`;