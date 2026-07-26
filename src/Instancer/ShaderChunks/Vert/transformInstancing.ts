export default `

    uniform mat4 uInstancerLocalInstanceMatrix;

    mat4 getModelMatrix() {
        mat4 instanceMatrix = getInstanceMatrix();
        return instanceMatrix * uInstancerLocalInstanceMatrix;
    }
`;