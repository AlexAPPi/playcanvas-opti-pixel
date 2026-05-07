export default `

    uniform sampler2D uDataTexture;
    uniform uint uPixelsSizePerInstance;

    void getBoundingBox(const in uint index, out vec3 center, out vec3 halfExtents, out vec2 extra) {

        int size = textureSize(uDataTexture, 0).x;
        int j = int(index * uPixelsSizePerInstance);
        int x = j % size;
        int y = j / size;

        vec4 data1 = texelFetch(uDataTexture, ivec2(x    , y), 0);
        vec4 data2 = texelFetch(uDataTexture, ivec2(x + 1, y), 0);

        extra       = vec2(data1.w, data2.w);
        center      = data1.xyz;
        halfExtents = data2.xyz;
    }
`;