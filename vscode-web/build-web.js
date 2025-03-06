/* eslint-disable @typescript-eslint/no-var-requires */
//https://github.com/Felx-B/vscode-web/tree/main
const process = require("process");
const os = require("os");
const fs = require("fs");
const fse = require("fs-extra");
const path = require("path");
const child_process = require("child_process");
const ghpages = require('gh-pages');

const args = process.argv.slice(2);

const ALWAYS_RECOMPILIE_VSCODE = false;

(async function() {
    const vscodeVersion = "1.97.2";
    const vscodeDir = `vscode-source-${vscodeVersion}`;
    const vscodeDistDir = `vscode-web-dist`;
    const tempDir = os.tmpdir();

    const rootDir = __dirname;
    const fullVSCodeDir = path.resolve(tempDir, vscodeDir);
    const fullVSCodeDistDir = path.resolve(rootDir, vscodeDistDir);

    if(!ALWAYS_RECOMPILIE_VSCODE && await directoryExists(fullVSCodeDistDir)) {
        console.log(`Found directory ${fullVSCodeDistDir}. Not re-building`);
    } else {
        if(await directoryExists(fullVSCodeDir)) {
            console.log(`Found directory ${fullVSCodeDir}`);
        } else {
            console.log(`Could not find directory ${fullVSCodeDir}. Cloning`);
            await exec(`git clone --depth 1 https://github.com/microsoft/vscode.git -b ${vscodeVersion} ${fullVSCodeDir}`);
        }

        process.chdir(fullVSCodeDir);

        // const yarnPath = path.resolve(rootDir, "..", "node_modules", "yarn", "bin", "yarn.js");
        // process.env.npm_execpath = yarnPath;

        if(await directoryExists("node_modules")) {
            console.log("Found node_modules");
        } else {
            console.log("Installing node_modules");
            // await exec(`${yarnPath} --cwd ${fullVSCodeDir}`);
            await exec(`cd ${fullVSCodeDir}`);
            await exec(`npm i`);
        }

        await fs.promises.copyFile(path.resolve(rootDir, "workbench.ts"), path.resolve(fullVSCodeDir, "src", "vs", "code", "browser", "workbench", "workbench.ts"));

        // await exec(`${yarnPath} --cwd ${fullVSCodeDir} gulp vscode-web-min`);
        await exec(`npm run gulp vscode-web-min`);

        if(await deleteDirectoryIfExists(fullVSCodeDistDir)) { console.log(`Found directory ${fullVSCodeDistDir}; deleting`); }

        await fs.promises.mkdir(fullVSCodeDistDir);
        await fse.copy(path.resolve(tempDir, "vscode-web"), fullVSCodeDistDir);
    }

    const extensionDir = path.resolve(rootDir, "..");
    const extensionDestDir = path.resolve(rootDir, "webnb");
    const extensionDestDistDir = path.resolve(extensionDestDir, "dist");
    process.chdir(extensionDir);
    await exec(`npm run compile`);

    if(await deleteDirectoryIfExists(extensionDestDir)) { console.log(`Found directory ${extensionDestDir}; deleting`); }

    await fs.promises.mkdir(extensionDestDistDir, { recursive: true });
    await fse.copy(path.resolve(extensionDir, "dist"), extensionDestDistDir);
    await fse.copy(path.resolve(extensionDir, "package.json"), path.resolve(extensionDestDir, "package.json"));

    const cnameDest = path.resolve(rootDir, "CNAME");
    if(await deleteFileIfExists(cnameDest)) { console.log(`Found file ${cnameDest}; deleting`); }

    const productLocalDest = path.resolve(extensionDestDir, "product.local.json");
    if(await deleteFileIfExists(productLocalDest)) { console.log(`Found file ${productLocalDest}; deleting`); }

    const samplesDestDir = path.resolve(rootDir, "sample-notebooks-extension");
    const samplesJSONFile = path.resolve(samplesDestDir, "samples.json");
    if(args.length > 0) {
        const pageRepo = args[0];
        if(!isGitRepo(pageRepo)) { throw new Error(`${pageRepo} does not appear to be the URL for a git repository. Stopping`); }

        const booksDir = path.resolve(rootDir, "samplenotebooks");
        const repoName = getRepoName(pageRepo);
        const fullRepoDest = path.resolve(booksDir, repoName);

        if(await deleteDirectoryIfExists(fullRepoDest)) { console.log(`Found directory ${fullRepoDest}; deleting`); }

        if(!await directoryExists(booksDir)) { await fs.promises.mkdir(booksDir); }

        console.log(`Cloning ${pageRepo} to ${fullRepoDest}`);
        await exec(`git clone --depth 1 ${pageRepo} ${fullRepoDest}`);

        const booksCombinedFile = readDirectoryRecursively(fullRepoDest);
        await fs.promises.writeFile(samplesJSONFile, JSON.stringify(booksCombinedFile, null, 4));
        process.chdir(samplesDestDir);

        await fse.copy(path.resolve(fullRepoDest, "CNAME"), cnameDest);

        if(await fileExists(path.resolve(fullRepoDest, "product.local.json"))) {
            await fse.copy(path.resolve(fullRepoDest, "product.local.json"), productLocalDest);
        }

        await exec(`npm install .`);
        await exec(`npm run compile`);

        process.chdir(rootDir);

        await publish(rootDir, { repo: pageRepo, src: ['**/*', '.nojekyll'], remove: ['.', 'sample-notebooks-extension/node_modules', 'books/**'] });
    } else {
        const samplesDir = path.resolve(rootDir, "..", "samples");
        const samplesCombinedFile = readDirectoryRecursively(samplesDir);
        await fs.promises.writeFile(samplesJSONFile, JSON.stringify(samplesCombinedFile, null, 4));
        process.chdir(samplesDestDir);

        await fse.copy(path.resolve(extensionDir, "CNAME"), cnameDest);

        await exec(`npm install .`);
        await exec(`npm run compile`);

        process.chdir(rootDir);

        await publish(rootDir, { src: ['**/*', '.nojekyll'], remove: ['.', 'sample-notebooks-extension/node_modules', 'books/**'] });
    }


    console.log('Published');
})().catch((err) => {
    console.error(err);
});

function publish(dir, config) {
    return new Promise((resolve, reject) => {
        ghpages.publish(dir, config, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

function readDirectoryRecursively(dir, extension=".dpage", ignore=['.git']) {
    const result = {};

    for (const item of fs.readdirSync(dir)) {
        if (ignore.includes(item)) { continue; }

        const itemPath = path.join(dir, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory()) {
            result[item] = readDirectoryRecursively(itemPath, extension);
        } else if (path.extname(itemPath) === extension) {
            const fileContent = fs.readFileSync(itemPath, 'utf-8');
            try {
                const parsed = JSON.parse(fileContent); // Parse and dump to remove spaces
                result[path.basename(item)] = JSON.stringify(parsed);
            } catch(err) {
                console.error(`Failed to parse JSON in file: ${itemPath}`);
            }
        }
    }

    return filterRootsWithNoLeafs(result);
}

async function directoryExists(path) {
    try {
        const stats = await fs.promises.stat(path);
        return stats.isDirectory();
    } catch(error) {
        if (error.code === 'ENOENT') {
            return false; // Directory does not exist
        }
        throw error; // An unexpected error occurred
    }
}

async function fileExists(path) {
    try {
        const stats = await fs.promises.stat(path);
        return stats.isFile();
    } catch(error) {
        if (error.code === 'ENOENT') {
            return false; // File does not exist
        }
        throw error; // An unexpected error occurred
    }
}

async function deleteDirectoryIfExists(path) {
    if(await directoryExists(path)) {
        await fs.promises.rm(path, { recursive: true });
        return true;
    } else {
        return false;
    }
}

async function deleteFileIfExists(path) {
    if(await fileExists(path)) {
        await fs.promises.rm(path);
        return true;
    } else {
        return false;
    }
}

async function exec(command) {
    child_process.execSync(command, { stdio: "inherit" });
}

function isGitRepo(url) {
    const gitPattern = /^(https:\/\/|git@)github\.com[:/a-zA-Z0-9_.-]+\.git$/;
    return gitPattern.test(url);
}

function getRepoName(url) {
    // Split the URL into segments
    const segments = url.split("/");

    // Extract the last segment and remove the .git extension if present
    let name = segments.pop();
    if (name.endsWith('.git')) {
        name = name.slice(0, -4);
    }

    return name;
}
function hasLeafs(obj) {
    // Check for null or undefined
    if (obj === null || obj === undefined) {
        return false;
    }

    // If the object is not an actual object, then it's a leaf
    if (typeof obj !== 'object') {
        return true;
    }

    // If it's an empty object, then it doesn't have leafs
    if (Object.keys(obj).length === 0) {
        return false;
    }

    // Loop through properties
    for (const key in obj) {
        if (hasLeafs(obj[key])) {
            return true;
        }
    }

    return false;
}

function filterRootsWithNoLeafs(obj) {
    // If it's not an object, return as is
    if (typeof obj !== 'object' || obj === null) {
        return obj;
    }

    // Initialize an empty object to hold the filtered properties
    let filteredObj = {};

    // Loop through the properties of the object
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            // Check if the property has any leafs
            if (hasLeafs(obj[key])) {
                // If it does, add it to the filtered object and filter its children as well
                filteredObj[key] = filterRootsWithNoLeafs(obj[key]);
            }
        }
    }

    return filteredObj;
}