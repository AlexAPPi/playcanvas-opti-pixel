export default `

    uniform uInstancerLocalInstanceMatrix: mat4x4f;

    fn getModelMatrix() -> mat4x4f {
        let instanceMatrix = getInstanceMatrix();
        return instanceMatrix * uniform.uInstancerLocalInstanceMatrix;
    }
`;