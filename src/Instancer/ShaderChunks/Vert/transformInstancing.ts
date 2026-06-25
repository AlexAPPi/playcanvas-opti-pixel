export default `

    uniform mat4 local_matrix_instance;

    mat4 getModelMatrix() {
        mat4 instanceMatrix = getInstanceMatrix();
        return instanceMatrix * local_matrix_instance;
    }
`;