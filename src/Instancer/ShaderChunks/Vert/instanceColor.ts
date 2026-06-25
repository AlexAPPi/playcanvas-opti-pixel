export default `

    uniform highp sampler2D uColorTexture;

    vec4 getInstanceColor() {
        int id = int(getInstanceId());
        int size = textureSize(uColorTexture, 0).x;
        int x = id % size;
        int y = id / size;
        return texelFetch(uColorTexture, ivec2(x, y), 0);
    }
`;