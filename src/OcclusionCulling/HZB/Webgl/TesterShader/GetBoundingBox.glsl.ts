export default `

    uniform sampler2D uCentersTexture;
    uniform sampler2D uHalfExtentsTexture;

    void getBoundingBox(const in uint index, out vec3 center, out vec3 halfExtents, out vec2 extra) {

        // Textures size must be eq
        int size = textureSize(uCentersTexture, 0).x;
        int j = int(index);
        int x = j % size;
        int y = j / size;

        vec4 data1 = texelFetch(uCentersTexture,     ivec2(x, y), 0);
        vec4 data2 = texelFetch(uHalfExtentsTexture, ivec2(x, y), 0);

        extra       = vec2(data1.w, data2.w);
        center      = data1.xyz;
        halfExtents = data2.xyz;
    }
`;