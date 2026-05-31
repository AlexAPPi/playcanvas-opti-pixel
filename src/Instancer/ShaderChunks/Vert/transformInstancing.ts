export default `

    mat4 getModelMatrix() {
        mat4 instanceMatrix = getInstanceMatrix();
        return matrix_model * instanceMatrix;
    }
`;