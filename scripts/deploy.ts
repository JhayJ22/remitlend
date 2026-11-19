import {
    Keypair,
    Operation,
    TransactionBuilder,
    rpc as Rpc,
    Address,
    nativeToScVal,
    xdr,
    StrKey,
} from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const CONFIG_PATH = path.join(__dirname, 'deploy-config.json');
const POLL_INTERVAL_MS = 2000;

// ── Immutable release bundle ────────────────────────────────────────────────────
//
// scripts/build.sh produces a release bundle directory containing a manifest
// (release-manifest.json) that pins the source revision, lockfile digests, test
// results, generated API schemas, WASM hashes and the deployment manifest. The
// deploy script refuses to run unless that bundle exists, is fresh, and every
// artifact hash matches the manifest. The bundle digest is recorded in the
// deployment manifest so every deployed artifact traces to one immutable build.
const DEFAULT_BUNDLE_DIR = path.join(__dirname, '../release-bundle');
const BUNDLE_MANIFEST_NAME = 'release-manifest.json';
const DEPLOYMENT_MANIFEST_NAME = 'deployment-manifest.json';
// A bundle older than this is considered stale and must be rebuilt.
const MAX_BUNDLE_AGE_MS = 24 * 60 * 60 * 1000;

interface BundleArtifact {
    path: string;
    sha256: string;
}

interface ReleaseBundleManifest {
    schemaVersion: number;
    sourceRevision: string;
    builtAt: string;
    lockfileDigests: Record<string, string>;
    testResults: { passed: number; failed: number; skipped: number; reportPath: string };
    apiSchemas: BundleArtifact[];
    wasm: BundleArtifact[];
    deploymentManifest: BundleArtifact;
}

interface VerifiedBundle {
    dir: string;
    manifest: ReleaseBundleManifest;
    // SHA-256 over the canonical manifest bytes — the immutable build identity.
    bundleDigest: string;
}

function sha256File(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertArtifact(bundleDir: string, artifact: BundleArtifact, label: string): void {
    const resolved = path.resolve(bundleDir, artifact.path);
    if (!resolved.startsWith(path.resolve(bundleDir) + path.sep)) {
        throw new Error(`Bundle verification failed: ${label} path escapes bundle: ${artifact.path}`);
    }
    if (!fs.existsSync(resolved)) {
        throw new Error(`Bundle verification failed: missing ${label} artifact ${artifact.path}`);
    }
    const actual = sha256File(resolved);
    if (actual !== artifact.sha256) {
        throw new Error(
            `Bundle verification failed: ${label} hash mismatch for ${artifact.path} ` +
                `(expected ${artifact.sha256}, got ${actual})`,
        );
    }
}

// Load and fully verify the release bundle. Throws on any missing, stale or
// tampered artifact so no partial deployment can occur.
function verifyReleaseBundle(bundleDir: string): VerifiedBundle {
    const manifestPath = path.join(bundleDir, BUNDLE_MANIFEST_NAME);
    if (!fs.existsSync(manifestPath)) {
        throw new Error(
            `Release bundle missing: ${manifestPath}. Run scripts/build.sh to produce an immutable bundle.`,
        );
    }

    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as ReleaseBundleManifest;

    if (manifest.schemaVersion !== 1) {
        throw new Error(`Unsupported release bundle schemaVersion: ${manifest.schemaVersion}`);
    }
    if (!manifest.sourceRevision || !/^[0-9a-f]{7,40}$/.test(manifest.sourceRevision)) {
        throw new Error(`Release bundle has invalid sourceRevision: ${manifest.sourceRevision}`);
    }

    const builtAt = Date.parse(manifest.builtAt);
    if (Number.isNaN(builtAt)) {
        throw new Error(`Release bundle has invalid builtAt timestamp: ${manifest.builtAt}`);
    }
    if (Date.now() - builtAt > MAX_BUNDLE_AGE_MS) {
        throw new Error(
            `Release bundle is stale (built ${manifest.builtAt}). Rebuild with scripts/build.sh.`,
        );
    }

    if (manifest.testResults.failed > 0) {
        throw new Error(
            `Release bundle records ${manifest.testResults.failed} failing test(s); refusing to deploy.`,
        );
    }

    for (const [name, digest] of Object.entries(manifest.lockfileDigests)) {
        const lockPath = path.resolve(bundleDir, name);
        if (!fs.existsSync(lockPath)) {
            throw new Error(`Bundle verification failed: missing lockfile ${name}`);
        }
        if (sha256File(lockPath) !== digest) {
            throw new Error(`Bundle verification failed: lockfile digest mismatch for ${name}`);
        }
    }

    for (const artifact of manifest.apiSchemas) assertArtifact(bundleDir, artifact, 'api-schema');
    for (const artifact of manifest.wasm) assertArtifact(bundleDir, artifact, 'wasm');
    assertArtifact(bundleDir, manifest.deploymentManifest, 'deployment-manifest');

    const bundleDigest = createHash('sha256').update(manifestBytes).digest('hex');
    return { dir: bundleDir, manifest, bundleDigest };
}

// Resolve the bundle's WASM artifact for a contract by file basename.
function resolveBundledWasm(bundle: VerifiedBundle, wasmPath: string): string {
    const base = path.basename(wasmPath);
    const artifact = bundle.manifest.wasm.find(a => path.basename(a.path) === base);
    if (!artifact) {
        throw new Error(`Release bundle does not contain WASM artifact ${base}`);
    }
    return path.resolve(bundle.dir, artifact.path);
}

// Compute the SHA-256 hash of WASM bytes — this is the on-chain upload key.
function computeWasmHash(wasm: Buffer): Buffer {
    return createHash('sha256').update(wasm).digest();
}

// Deterministic per-contract salt so re-runs don't stomp each other's addresses.
function contractSalt(name: string): Buffer {
    return createHash('sha256').update(`remitlend:${name}`).digest();
}

// Extract the newly created contract ID from transaction result metadata.
function extractContractId(resultMeta: xdr.TransactionMeta): string {
    const v3 = resultMeta.v3();
    for (const opMeta of v3.operations()) {
        for (const change of opMeta.changes()) {
            if (change.switch().name !== 'ledgerEntryCreated') continue;
            const data = change.created().data();
            if (data.switch().name !== 'contractData') continue;
            const cd = data.contractData();
            if (cd.key().switch().name !== 'scvLedgerKeyContractInstance') continue;
            const contract = cd.contract();
            if (contract.switch().name === 'scAddressTypeContract') {
                return StrKey.encodeContract(
                    Buffer.from(contract.contractId() as unknown as Uint8Array),
                );
            }
        }
    }
    throw new Error('Could not extract contract ID from transaction metadata');
}

async function sendTx(
    server: Rpc.Server,
    tx: ReturnType<TransactionBuilder['build']>,
    account: Keypair,
): Promise<Rpc.Api.GetSuccessfulTransactionResponse> {
    const sim = await server.simulateTransaction(tx);
    if (Rpc.Api.isSimulationError(sim)) {
        throw new Error(`Simulation failed: ${JSON.stringify(sim.error, null, 2)}`);
    }

    const preparedTx = await server.prepareTransaction(tx);
    preparedTx.sign(account);

    const sendResponse = await server.sendTransaction(preparedTx);
    if (sendResponse.status !== 'PENDING') {
        throw new Error(`Send failed: ${JSON.stringify(sendResponse, null, 2)}`);
    }

    console.log(`    tx ${sendResponse.hash} … polling`);

    let txResponse = await server.getTransaction(sendResponse.hash);
    while (txResponse.status === 'NOT_FOUND') {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        txResponse = await server.getTransaction(sendResponse.hash);
    }

    if (txResponse.status !== 'SUCCESS') {
        throw new Error(`Transaction failed: ${JSON.stringify(txResponse, null, 2)}`);
    }

    return txResponse as Rpc.Api.GetSuccessfulTransactionResponse;
}

// Upload WASM bytecode to the network and return its SHA-256 hash.
// If the same WASM was uploaded before the hash is already indexed, but the
// operation is idempotent and safe to repeat.
async function uploadWasm(
    server: Rpc.Server,
    wasmPath: string,
    account: Keypair,
    networkPassphrase: string,
): Promise<Buffer> {
    const wasm = await fs.readFile(wasmPath);
    const wasmHash = computeWasmHash(wasm);

    console.log(`  uploading ${path.basename(wasmPath)} (hash ${wasmHash.toString('hex').slice(0, 12)}…)`);

    const source = await server.getAccount(account.publicKey());
    const tx = new TransactionBuilder(source, { fee: '100000', networkPassphrase })
        .addOperation(Operation.uploadContractWasm({ wasm }))
        .setTimeout(30)
        .build();

    await sendTx(server, tx, account);
    return wasmHash;
}

// Instantiate a contract from an uploaded WASM hash. Returns the new contract ID.
async function createInstance(
    server: Rpc.Server,
    wasmHash: Buffer,
    salt: Buffer,
    account: Keypair,
    networkPassphrase: string,
): Promise<string> {
    const source = await server.getAccount(account.publicKey());
    const tx = new TransactionBuilder(source, { fee: '100000', networkPassphrase })
        .addOperation(
            Operation.createCustomContract({
                address: Address.fromString(account.publicKey()),
                wasmHash,
                salt,
            }),
        )
        .setTimeout(30)
        .build();

    const result = await sendTx(server, tx, account);
    return extractContractId(result.resultMetaXdr);
}

// Call a contract function with positional arguments.
async function invoke(
    server: Rpc.Server,
    contractId: string,
    method: string,
    args: unknown[],
    account: Keypair,
    networkPassphrase: string,
): Promise<void> {
    const source = await server.getAccount(account.publicKey());
    const tx = new TransactionBuilder(source, { fee: '100000', networkPassphrase })
        .addOperation(
            Operation.invokeHostFunction({
                func: xdr.HostFunction.hostFunctionTypeInvokeContract(
                    new xdr.InvokeContractArgs({
                        contractAddress: Address.fromString(contractId).toScAddress(),
                        functionName: method,
                        args: args.map(arg => nativeToScVal(arg)),
                    }),
                ),
                auth: [],
            }),
        )
        .setTimeout(30)
        .build();

    await sendTx(server, tx, account);
}

async function main() {
    const network = process.argv[2] || 'testnet';
    const config = (await fs.readJson(CONFIG_PATH))[network];
    if (!config) throw new Error(`No config for network: ${network}`);

    // Verify the immutable release bundle before touching the network. Any
    // failure here aborts with no on-chain or filesystem side effects.
    const bundleDir = process.env.RELEASE_BUNDLE_DIR
        ? path.resolve(process.env.RELEASE_BUNDLE_DIR)
        : DEFAULT_BUNDLE_DIR;
    console.log(`\nVerifying release bundle at ${bundleDir} …`);
    const bundle = verifyReleaseBundle(bundleDir);
    console.log(`  source revision : ${bundle.manifest.sourceRevision}`);
    console.log(`  bundle digest   : ${bundle.bundleDigest}`);

    const secretKey = process.env.SECRET_KEY;
    if (!secretKey) throw new Error('SECRET_KEY environment variable is required');

    const account = Keypair.fromSecret(secretKey);
    // Fall back to the deployer's own key when admin is not set in config.
    const adminAddr =
        config.admin === 'YOUR_ADMIN_PUBLIC_KEY' ? account.publicKey() : config.admin;

    const server = new Rpc.Server(config.rpcUrl);
    const passphrase = config.networkPassphrase;

    console.log(`\nRemitLend deployment → ${network}`);
    console.log(`admin : ${adminAddr}`);
    console.log(`token : ${config.token}\n`);

    // ── 1. Upload all WASM binaries ─────────────────────────────────────────────
    // WASM is sourced from the verified bundle, never from the working tree, so
    // the deployed bytecode is exactly what the bundle manifest attests to.
    console.log('[1/4] Uploading WASM binaries…');
    const nftWasmHash = await uploadWasm(
        server,
        resolveBundledWasm(bundle, config.contracts.remittance_nft.wasm),
        account,
        passphrase,
    );
    const poolWasmHash = await uploadWasm(
        server,
        resolveBundledWasm(bundle, config.contracts.lending_pool.wasm),
        account,
        passphrase,
    );
    const managerWasmHash = await uploadWasm(
        server,
        resolveBundledWasm(bundle, config.contracts.loan_manager.wasm),
        account,
        passphrase,
    );
    const govWasmHash = await uploadWasm(
        server,
        resolveBundledWasm(bundle, config.contracts.multisig_governance.wasm),
        account,
        passphrase,
    );

    // ── 2. Instantiate contracts ────────────────────────────────────────────────
    console.log('\n[2/4] Creating contract instances…');

    console.log('  RemittanceNFT');
    const nftContractId = await createInstance(server, nftWasmHash, contractSalt('nft'), account, passphrase);
    console.log(`    → ${nftContractId}`);

    console.log('  LendingPool');
    const poolContractId = await createInstance(server, poolWasmHash, contractSalt('pool'), account, passphrase);
    console.log(`    → ${poolContractId}`);

    console.log('  LoanManager');
    const managerContractId = await createInstance(server, managerWasmHash, contractSalt('manager'), account, passphrase);
    console.log(`    → ${managerContractId}`);

    console.log('  Governance');
    const govContractId = await createInstance(server, govWasmHash, contractSalt('governance'), account, passphrase);
    console.log(`    → ${govContractId}`);

    // ── 3. Initialize in dependency order ──────────────────────────────────────
    //
    // Ordering constraints:
    //   a. NFT must be initialized before authorize_minter can be called.
    //   b. authorize_minter(LoanManager) must run BEFORE LoanManager.initialize,
    //      because LoanManager.initialize asserts it is already an authorized minter.
    //   c. LendingPool has no dependency on NFT or LoanManager at init time.
    //   d. LoanManager.initialize takes (nft, pool, token, admin) so both NFT and
    //      Pool addresses must be known first.
    //   e. Governance.initialize takes (admin, target_contract). We point it at
    //      LoanManager as the primary governed contract.
    //
    console.log('\n[3/4] Initializing contracts…');

    // NFT
    console.log('  NFT.initialize');
    await invoke(server, nftContractId, 'initialize', [adminAddr], account, passphrase);

    // Authorize LoanManager as minter BEFORE LoanManager.initialize checks for it.
    console.log('  NFT.authorize_minter(LoanManager)');
    await invoke(server, nftContractId, 'authorize_minter', [managerContractId], account, passphrase);

    // LendingPool
    console.log('  LendingPool.initialize');
    await invoke(server, poolContractId, 'initialize', [config.token, adminAddr], account, passphrase);

    // LoanManager — validates minter authorization on-chain during this call.
    console.log('  LoanManager.initialize');
    await invoke(
        server,
        managerContractId,
        'initialize',
        [nftContractId, poolContractId, config.token, adminAddr],
        account,
        passphrase,
    );

    // Governance — target is LoanManager (the core protocol contract).
    console.log('  Governance.initialize(target=LoanManager)');
    await invoke(server, govContractId, 'initialize', [adminAddr, managerContractId], account, passphrase);

    // ── 4. Persist contract IDs ─────────────────────────────────────────────────
    console.log('\n[4/4] Writing contract addresses to .env files…');

    const envBlock = [
        ``,
        `# RemitLend contracts — ${network} — ${new Date().toISOString()}`,
        `NEXT_PUBLIC_NFT_CONTRACT_ID=${nftContractId}`,
        `NEXT_PUBLIC_POOL_CONTRACT_ID=${poolContractId}`,
        `NEXT_PUBLIC_MANAGER_CONTRACT_ID=${managerContractId}`,
        `NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID=${govContractId}`,
    ].join('\n');

    await fs.appendFile(path.join(__dirname, '../frontend/.env.local'), envBlock);
    await fs.appendFile(path.join(__dirname, '../backend/.env'), envBlock);

    // Record the immutable build identity alongside the deployed addresses so
    // every artifact traces back to one verified release bundle.
    const deploymentManifest = {
        schemaVersion: 1,
        network,
        deployedAt: new Date().toISOString(),
        sourceRevision: bundle.manifest.sourceRevision,
        bundleDigest: bundle.bundleDigest,
        wasmHashes: {
            remittance_nft: nftWasmHash.toString('hex'),
            lending_pool: poolWasmHash.toString('hex'),
            loan_manager: managerWasmHash.toString('hex'),
            multisig_governance: govWasmHash.toString('hex'),
        },
        contracts: {
            remittance_nft: nftContractId,
            lending_pool: poolContractId,
            loan_manager: managerContractId,
            multisig_governance: govContractId,
        },
    };
    const deploymentManifestPath = path.join(bundleDir, DEPLOYMENT_MANIFEST_NAME);
    await fs.writeJson(deploymentManifestPath, deploymentManifest, { spaces: 2 });
    console.log(`\nDeployment manifest written to ${deploymentManifestPath}`);

    console.log('\nDeployment complete.');
    console.log(`  RemittanceNFT  : ${nftContractId}`);
    console.log(`  LendingPool    : ${poolContractId}`);
    console.log(`  LoanManager    : ${managerContractId}`);
    console.log(`  Governance     : ${govContractId}`);
}

main().catch(error => {
    console.error('\nDeployment failed:', error instanceof Error ? error.message : error);
    process.exit(1);
});
