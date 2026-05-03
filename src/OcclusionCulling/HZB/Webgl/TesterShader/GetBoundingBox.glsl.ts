export default `

    uniform sampler2D uDataTexture;
    uniform uint uPixelsSizePerInstance;

    void getBoundingBox(const in uint index, out vec3 center, out vec3 halfExtents) {

        int size = textureSize(uDataTexture, 0).x;
        int j = int(index * uPixelsSizePerInstance);
        int x = j % size;
        int y = j / size;

        center      = texelFetch(uDataTexture, ivec2(x    , y), 0).xyz;
        halfExtents = texelFetch(uDataTexture, ivec2(x + 1, y), 0).xyz;
    }
`;