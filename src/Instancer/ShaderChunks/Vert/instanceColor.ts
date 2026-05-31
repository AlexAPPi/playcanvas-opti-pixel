export default `

    uniform highp sampler2D uColorTexture;

    vec4 getInstanceColor() {
        int size = textureSize(uColorTexture, 0).x;
        int j = int(aInstanceIndex);
        int x = j % size;
        int y = j / size;
        return texelFetch(uColorTexture, ivec2(x, y), 0);
    }
`;