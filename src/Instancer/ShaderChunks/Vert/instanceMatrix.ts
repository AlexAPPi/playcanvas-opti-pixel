export default `

    uniform highp sampler2D uInstancerMatricesTexture;

    mat4 getInstanceMatrix() {
        int id = int(getInstanceId());
        int size = textureSize(uInstancerMatricesTexture, 0).x;
        int j = id * 4;
        int x = j % size;
        int y = j / size;
        vec4 v1 = texelFetch(uInstancerMatricesTexture, ivec2(x, y), 0);
        vec4 v2 = texelFetch(uInstancerMatricesTexture, ivec2(x + 1, y), 0);
        vec4 v3 = texelFetch(uInstancerMatricesTexture, ivec2(x + 2, y), 0);
        vec4 v4 = texelFetch(uInstancerMatricesTexture, ivec2(x + 3, y), 0);
        return mat4(v1, v2, v3, v4);
    }
`;