export default `
    attribute vec3 aPosition;
    uniform mat4 matrix_modelViewProjectionOccCull;
    void main(void) {
        gl_Position = matrix_modelViewProjectionOccCull * vec4(aPosition, 1.0);
    }
`;