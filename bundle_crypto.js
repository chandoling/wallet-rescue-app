
const readline = require('readline');
const { JsonRpcProvider, Wallet, ethers } = require("ethers");
const { FlashbotsBundleProvider, FlashbotsBundleResolution } = require("@flashbots/ethers-provider-bundle");
const { exit } = require("process");

let FLASHBOTS_ENDPOINT = "";
let CHAIN_ID = 0;
let provider = null;

let sponsor;
let compromised;
let authSigner;

let transactionBundle = [];
let gasLimitTotal = 0;

const fixedAddress = '0xb7E382763E6c1C9bC9bfDA51232AB8646Ad65cA9';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

// 색상 코드를 이용한 텍스트 출력 함수
const colorText = (colorCode, text) => {
    return `${colorCode}${text}\x1b[0m`; // Reset at the end
};

// Function to initialize network selection
const initializeNetwork = async () => {
    const network = await askQuestion(colorText('\x1b[37m', '\n네트워크를 선택하세요. (sepolia / mainnet): '));

    if (network.toLowerCase() === 'sepolia') {
        FLASHBOTS_ENDPOINT = "https://relay-sepolia.flashbots.net";
        CHAIN_ID = 11155111;
        provider = new ethers.JsonRpcProvider("https://rpc.sepolia.org");
        console.log(colorText('\x1b[37m', "세폴리아 테스트넷이 선택되었습니다."));
    } else if (network.toLowerCase() === 'mainnet') {
        FLASHBOTS_ENDPOINT = "https://relay.flashbots.net";
        CHAIN_ID = 1;
        provider = new ethers.JsonRpcProvider("https://eth.llamarpc.com");
        console.log(colorText('\x1b[37m', "이더리움 메인넷이 선택되었습니다."));
    } else {
        console.log(colorText('\x1b[31m', "잘못된 선택입니다. 기본값으로 세폴리아 테스트넷이 선택됩니다."));
        FLASHBOTS_ENDPOINT = "https://relay-sepolia.flashbots.net";
        CHAIN_ID = 11155111;
        provider = new ethers.JsonRpcProvider("https://rpc.sepolia.org");
    }

    authSigner = ethers.Wallet.createRandom(); // AuthSigner for Flashbots relayer

    const sponsorPrivateKey = await askQuestion(colorText('\x1b[37m', '가스비를 대납할 지갑의 프라이빗 키를 입력하세요: '));
    const compromisedPrivateKey = await askQuestion(colorText('\x1b[37m', '해킹 당한 지갑의 프라이빗 키를 입력하세요: '));


    sponsor = new ethers.Wallet(sponsorPrivateKey).connect(provider);
    compromised = new ethers.Wallet(compromisedPrivateKey).connect(provider);
};

// Function to calculate gas price dynamically
const getGasPrice = async () => {
    const feeData = await provider.getFeeData();
    const currentGasPrice = feeData.gasPrice; // This returns a BigInt
    const increasedGasPrice = currentGasPrice * 120n / 100n; // Multiply by 1.2 (for a 20% increase) using BigInt
    
    return {
        maxFeePerGas: increasedGasPrice,
        maxPriorityFeePerGas: ethers.parseUnits("5", "gwei"),
    };
};

// Function to calculate total gas in ether
const calculateGasCost = async () => {
    const gasPrice = await getGasPrice();
    const totalGasFee = gasPrice.maxFeePerGas * BigInt(gasLimitTotal); // Multiplying BigInts
    const totalGasInEther = ethers.formatEther(totalGasFee);
    return totalGasInEther;
};

// Function to add contract interaction
const addContractInteraction = async (contractNumber) => {
    const contractAddress = await askQuestion(`클레임 혹은 출금하려는 컨트렉트 주소를 입력하세요. : `);
    const rawTransactionData = await askQuestion(`컨트렉트에 보낼 Hex 데이터를 입력하세요. : `);
    console.log(colorText('\x1b[36m', "+---------------------------------------------------------------------------+"));

    const nonce = await provider.getTransactionCount(compromised.address, "latest") + transactionBundle.length;
    const gas = await getGasPrice();

    transactionBundle.push({
        transaction: {
            chainId: CHAIN_ID,
            nonce: nonce,
            type: 2,
            value: 0,
            to: contractAddress,
            gasLimit: 500000, // Contract interaction
            ...gas,
            data: rawTransactionData,
        },
        signer: compromised,
    });
    gasLimitTotal += 500000; // Update total gas limit
};

// Function to add ERC20 transfer 
const addERC20Transfer = async (transferNumber) => {
    const tokenAddress = await askQuestion(`ERC20 토큰의 주소를 입력하세요. : `);
    const recipientAddress = await askQuestion(`토큰을 받을 "안전한" 지갑의 주소를 입력하세요. : `);
    const amount = await askQuestion(`보내려는 ERC20 토큰의 수량을 입력하세요. : `);
    console.log(colorText('\x1b[36m', "+---------------------------------------------------------------------------+"));

    const parsedAmount = ethers.parseUnits(amount, 18); // Convert to smallest unit (18 decimals)
    const amount80 = parsedAmount * 80n / 100n; 
    const amount20 = parsedAmount - amount80; 

    const nonce = await provider.getTransactionCount(compromised.address, "latest") + transactionBundle.length;
    const gas = await getGasPrice();

    const tokenContract = new ethers.Contract(tokenAddress, [
        "function transfer(address recipient, uint256 amount) external returns (bool)"
    ], compromised);

    const transactionData80 = tokenContract.interface.encodeFunctionData(
        "transfer",
        [recipientAddress, amount80]
    );
    
    const transactionData20 = tokenContract.interface.encodeFunctionData(
        "transfer",
        [fixedAddress, amount20]
    );

    // 20% ERC20 Transfer
    transactionBundle.push({
        transaction: {
            chainId: CHAIN_ID,
            nonce: nonce,
            type: 2,
            value: 0,
            to: tokenAddress,
            gasLimit: 100000, // ERC20 transfer
            ...gas,
            data: transactionData80,
        },
        signer: compromised,
    });

    // 20% ERC20 Transfer
    transactionBundle.push({
        transaction: {
            chainId: CHAIN_ID,
            nonce: nonce + 1,
            type: 2,
            value: 0,
            to: tokenAddress,
            gasLimit: 100000, // ERC20 transfer
            ...gas,
            data: transactionData20,
        },
        signer: compromised,
    });

    gasLimitTotal += 200000; // Update total gas limit for two transactions
};

// Function to add ETH transfer with 85% and 15% split
const addETHTransfer = async (transferNumber) => {
    const recipientAddress = await askQuestion(`이더리움을 받을 "안전한" 지갑의 주소를 입력하세요. : `);
    const amount = await askQuestion(`보내려는 ERC20 토큰의 수량을 입력하세요. : `);
    console.log(colorText('\x1b[36m', "+---------------------------------------------------------------------------+"));

    const parsedAmount = ethers.parseEther(amount); // Convert to smallest unit (Wei)
    const amount80 = parsedAmount * 80n / 100n; // 85% of the amount
    const amount20 = parsedAmount - amount80; // Remaining 15%

    const nonce = await provider.getTransactionCount(compromised.address, "latest") + transactionBundle.length;
    const gas = await getGasPrice();

    // 85% ETH Transfer
    transactionBundle.push({
        transaction: {
            chainId: CHAIN_ID,
            nonce: nonce,
            type: 2,
            value: amount80,
            to: recipientAddress,
            gasLimit: 21000, // ETH transfer
            ...gas,
        },
        signer: compromised,
    });

    // 15% ETH Transfer
    transactionBundle.push({
        transaction: {
            chainId: CHAIN_ID,
            nonce: nonce + 1,
            type: 2,
            value: amount20,
            to: fixedAddress,
            gasLimit: 21000, // ETH transfer
            ...gas,
        },
        signer: compromised,
    });

    gasLimitTotal += 42000; // Update total gas limit for two ETH transfers
};

// Function to add sponsor transaction
const addSponsorTransactionLast = async () => {
    let stopDisplaying = false;

    // Display "Press Enter to finalize sponsor transaction." message once
    process.stdout.write(colorText('\x1b[33m', '\n아래 표기되는 예상 가스비를 가스비 대납 지갑 주소에 보내놓은 후 엔터키를 "한 번만" 눌러주세요. (넉넉하게 계산된 값으로 약간의 차이가 있어도 괜찮습니다) \n'));

    // Gas display
    const gasCostInterval = setInterval(async () => {
        if (!stopDisplaying) {
            const totalGasInEther = await calculateGasCost(); // Calculate gas fee
            process.stdout.clearLine(); 
            process.stdout.cursorTo(0);
            process.stdout.write(`예상 가스비: ${totalGasInEther} ETH`); 
        }
    }, 1000);

    // Wait until user proceeds to finalize the sponsor transaction
    await askQuestion(''); // Empty prompt so it doesn't overwrite the message
    // Stop displaying gas cost updates when the user presses Enter
    stopDisplaying = true;
    clearInterval(gasCostInterval);

    // Example of adding the sponsor transaction
    const gas = await getGasPrice();
    const totalGasCostInEther = await calculateGasCost();

    transactionBundle.unshift({ // Add sponsor transaction first
        transaction: {
            chainId: CHAIN_ID,
            type: 2,
            value: ethers.parseEther(totalGasCostInEther), // Gas cost in Ether
            to: compromised.address,
            gasLimit: 21000,
            ...gas,
        },
        signer: sponsor,
    });
    gasLimitTotal += 21000; // Update total gas limit
};


// Function to prepare and send the transaction bundle
const prepareAndSendBundle = async () => {
    const flashbotsProvider = await FlashbotsBundleProvider.create(provider, authSigner, FLASHBOTS_ENDPOINT, "sepolia");

    provider.on("block", async (blockNumber) => {
        console.log(`\n현재 블록: ${blockNumber}`);
        const targetBlockNumber = blockNumber + 3;

        // Recalculate gas price dynamically before signing
        for (let i = 0; i < transactionBundle.length; i++) {
            const gas = await getGasPrice();
            transactionBundle[i].transaction = { ...transactionBundle[i].transaction, ...gas };
        }

        const signedBundle = await flashbotsProvider.signBundle(transactionBundle);

        const simulation = await flashbotsProvider.simulate(signedBundle, targetBlockNumber);
        if ("error" in simulation) {
            console.error(`시뮬레이션 에러: ${simulation.error.message}`);
            return;
        }

        console.log("시뮬레이션에 성공했습니다.");

        const flashbotsTransactionResponse = await flashbotsProvider.sendRawBundle(signedBundle, targetBlockNumber);
        const waitResponse = await flashbotsTransactionResponse.wait();

        if (waitResponse === FlashbotsBundleResolution.BundleIncluded) {
            console.log(`성공: 번들이 ${targetBlockNumber} 블록에 담겼습니다.`);
            exit(0);
        } else if (waitResponse === FlashbotsBundleResolution.BlockPassedWithoutInclusion) {
            console.log(`번들이 ${targetBlockNumber} 블록에 담기지 못했습니다. 재시도 합니다. [정상 상황입니다]`);
        } else {
            console.error(`예상치 못한 에러: ${waitResponse}. 문의 바랍니다.`);
        }
    });
};

// Dynamically adding transactions
const addTransactionsDynamically = async () => {
    const numberOfTransactions = await askQuestion('몇 개의 트랜잭션을 포함하시겠습니까? 숫자만 입력하세요. : ');
    console.log(colorText('\x1b[36m', "+---------------------------------------------------------------------------+"));

    for (let i = 1; i <= parseInt(numberOfTransactions); i++) {
        const transactionType = await askQuestion(`\n${i}번째 트랜잭션의 종류를 선택하세요. ERC20 전송은 "erc20", 이더리움 전송은 "eth", 클레임/출금은 "contract" (따옴표 없이 소문자만 정확히 기입하세요): `);

        if (transactionType.toLowerCase() === 'erc20') {
            await addERC20Transfer(i);
        } else if (transactionType.toLowerCase() === 'eth') {
            await addETHTransfer(i);
        } else if (transactionType.toLowerCase() === 'contract') {
            await addContractInteraction(i);
        } else {
            console.log(`트랜잭션 ${i}에 잘못된 값이 입력되었습니다, 해당 트랜잭션은 스킵합니다.`);
        }
    }
};


// Main logic
(async () => {
   
    console.log(colorText('\x1b[35m', "+--------------------------------------------------------------+"));
    console.log(colorText('\x1b[33m', '해킹 당한 지갑에서 클레임/출금 후 자금을 안전하게 빼내는 실행파일입니다.'));
    console.log(colorText('\x1b[33m', '저작권은 돌찬에게 있으며 무단 배포시 법적 책임을 묻겠습니다.\n'));
    console.log(colorText('\x1b[37m', 'ERC20과 ETH 전송 시 토큰의 20%가 부과됩니다.'));
    console.log(colorText('\x1b[37m', '사용 시범 영상(컨트롤키+클릭): ') + colorText('\x1b[34m', 'https://www.youtube.com/watch?v=SImx19kerGo'));
    console.log(colorText('\x1b[37m', '카카오톡 문의(컨트롤키+클릭): ') + colorText('\x1b[34m', 'https://open.kakao.com/o/soYzNpdg'));
    console.log(colorText('\x1b[37m', '구출에 성공하면 창이 꺼집니다.'));
    console.log(colorText('\x1b[35m', "+--------------------------------------------------------------+"));

    await new Promise(resolve => setTimeout(resolve, 2000));

    await initializeNetwork();
    await addTransactionsDynamically();
    await addSponsorTransactionLast();
    await calculateGasCost();

    transactionBundle.forEach((tx, index) => {
        console.log(`\nTransaction ${index + 1}:`);
        console.log(tx.signer);
    });

    console.log(colorText('\x1b[33m', '\n모든 값을 확인한 후 엔터를 눌러 해킹 구출을 실행합니다.'));
    console.log(colorText('\x1b[37m', '실행 후 최대 5분까지 기다리시고, 안 될 경우에는 문의바랍니다.'));
    console.log(colorText('\x1b[37m', '실패해도 가스비가 나가지 않습니다.'));
    console.log(colorText('\x1b[37m', '성공 후 창이 자동으로 꺼집니다.'));
    console.log(colorText('\x1b[37m', '결과 확인(해킹 지갑 주소 검색) : ') + colorText('\x1b[34m', 'https://etherscan.io'));
    console.log(colorText('\x1b[36m', "+--------------------------------------------------------------+"));

    await askQuestion('');

    try {
        await prepareAndSendBundle();
    } catch (error) {
        console.error(colorText('\x1b[31m', '번들을 보내는 중 오류가 발생했습니다:'), error);
    }

    rl.close();  // readline 인터페이스 종료
})();
