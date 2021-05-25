/**
 * @notice Deploys a TOY financial contract, registers it with the DVM, and goes through a simple user flow.
 * @dev OptimisticDepositBox is an example financial contract that integrates the optimistic oracle for on-chain price discovery.
 * It is intended for educational purposes and would not be very useful in practice. The purpose of the contract
 * is to custody a user's ERC20 token balance. The user links the OptimisticDepositBox with one of the price identifiers
 * enabled on UMA. For example, the user might deposit ETH into the OptimisticDepositBox and register it with the "ETHUSD"
 * price identifier. The user can now withdraw a "USD"-denominated amount of "ETH" from their OptimisticDepositBox via
 * smart contract calls. The feature introduced by Optimistic Oracle is optimistic on-chain pricing of the user's ERC20 balance.
 * In this example, the user would not have been able to transfer "USD"-denominated amounts of "ETH" without referencing an
 * off-chain "ETHUSD" price feed. The Optimistic Oracle therefore enables the user to "pull" a reference price.
 *
 * This script includes steps to deploy a "ETHUSD" OptimisticDepositBox and use the Optimistic Oracle
 * to withdraw USD-denominated amounts of ETH.
 *
 * How to run:
 * - `cd core && $(npm bin)/truffle exec ./scripts/demo/OptimisticDepositBox.js --network test`
 * Assumptions:
 * - User is using a local blockchain (i.e. not Kovan/Ropsten/Rinkeby/Mainnet)
 * - User is running this script in the web3 environment injected by Truffle.
 * - User is sending transactions from accounts[0] of the injected web3.
 * - User is using wETH as the collateral ERC20.
 * - User is referencing the ETHUSD pricefeed identifier.
 * Prerequisites:
 * - Migrate the contracts via `$(npm bin)/truffle migrate --reset --network test`.
 * - The migration step ensures that the user is the owner of the Finder, IdentifierWhitelist,
 *   Registry, and other important system contracts and can therefore modify their configurations.
 */

// Helper modules
const { toWei, fromWei, utf8ToHex, hexToUtf8 } = web3.utils;
const { interfaceName } = require("@uma/common");
const { RegistryRolesEnum } = require("@uma/common");

const OptimisticDepositBox = artifacts.require("OptimisticDepositBox");
const WETH9 = artifacts.require("WETH9");
const IdentifierWhitelist = artifacts.require("IdentifierWhitelist");
const Finder = artifacts.require("Finder");
const Timer = artifacts.require("Timer");
const Registry = artifacts.require("Registry");
const MockOracle = artifacts.require("MockOracle");

// Constants
const priceFeedIdentifier = utf8ToHex("ETH/USD");

// Deploy contract and return its address.
const deploy = async () => {
  console.group("1. Deploying new OptimisticDepositBox");
  const collateral = await WETH9.deployed();
  console.log("- Using WETH as collateral token");

  // Pricefeed identifier must be whitelisted prior to OptimisticDepositBox construction.
  const identifierWhitelist = await IdentifierWhitelist.deployed();
  await identifierWhitelist.addSupportedIdentifier(priceFeedIdentifier);
  console.log(`- Pricefeed identifier for ${hexToUtf8(priceFeedIdentifier)} is whitelisted`);

  // The following steps would differ if the user is on a testnet like Kovan in the following ways:
  // - The user would not need to deploy a "Mock Oracle" and register it with the Finder,
  // but using the mock oracle is convenient for testing by allowing the user to manually resolves prices.
  // - The user should pass in the zero address (i.e. 0x0) for the Timer, but using the deployed Timer
  // for testing purposes is convenient because they can advance time as needed.
  const finder = await Finder.deployed();
  const mockOracle = await MockOracle.new(finder.address, Timer.address);
  const mockOracleInterfaceName = utf8ToHex(interfaceName.Oracle);
  await finder.changeImplementationAddress(mockOracleInterfaceName, mockOracle.address);
  console.log("- Deployed a MockOracle");

  // Deploy a new OptimisticDepositBox contract. We pass in the collateral token address (i.e. the token we will deposit into
  // the contract), the Finder address (which stores references to all of the important system contracts like
  // the oracle), the pricefeed identifier we will use to pull the price of our collateral (denominated in some other
  // asset), and a Timer contract address, which is a contract deployed specifically to aid time-dependent testing.
  const optimisticDepositBox = await OptimisticDepositBox.new(
    collateral.address,
    finder.address,
    priceFeedIdentifier,
    Timer.address
  );
  console.log("- Deployed a new OptimisticDepositBox and linked it with the MockOracle");
  console.groupEnd();
  return optimisticDepositBox.address;
};

// Register contract with DVM.
const register = async (optimisticDepositBoxAddress) => {
  console.group("2. Registering OptimisticDepositBox with DVM");

  // To use the DVM, every financial contract needs to be registered. Since the OptimisticDepositBox
  // is intended to be used on local blockchains for educational purposes, it has an
  // `initialize()` public method that will register itself with the DVM.  Therefore
  // we need to grant the OptimisticDepositBox the power to register contracts with the DVM.
  //
  // Note: In production environments, only the Governor contract owns the privilege to register contracts
  // with the DVM. Therefore, the `initialize()` method would fail in production environments.
  const optimisticDepositBox = await OptimisticDepositBox.at(optimisticDepositBoxAddress);

  // The `CONTRACT_CREATOR` role grants the OptimisticDepositBox the power to register itself with the DVM.
  // This step assumes that the user has the ability to assign Registry roles, which is a role
  // held by the deployer of the Registry.
  const registry = await Registry.deployed();
  await registry.addMember(RegistryRolesEnum.CONTRACT_CREATOR, optimisticDepositBox.address);
  console.log("- Granted OptimisticDepositBox contract right to register itself with DVM");
  await optimisticDepositBox.initialize();
  console.log("- OptimisticDepositBox is registered");
  console.groupEnd();
  return;
};

// Set up allowances and mint collateral tokens.
const setupWallets = async (optimisticDepositBoxAddress, amountOfWethToMint) => {
  const accounts = await web3.eth.getAccounts();

  console.group("3. Minting ERC20 to user and giving OptimisticDepositBox allowance to transfer collateral");
  // This WETH contract is copied from the officially deployed WETH contract on mainnet.
  const collateral = await WETH9.deployed();

  // WETH must be converted from ETH via `deposit()`.
  await collateral.deposit({ value: amountOfWethToMint });
  console.log(`- Converted ${fromWei(amountOfWethToMint)} ETH into WETH`);
  const postBalance = await collateral.balanceOf(accounts[0]);
  console.log(`- User's WETH balance: ${fromWei(postBalance.toString())}`);

  // OptimisticDepositBox needs to be able to transfer collateral on behalf of user.
  await collateral.approve(optimisticDepositBoxAddress, amountOfWethToMint);
  console.log("- Increased OptimisticDepositBox allowance to spend WETH");
  const postAllowance = await collateral.allowance(accounts[0], optimisticDepositBoxAddress);
  console.log(`- Contract's WETH allowance: ${fromWei(postAllowance.toString())}`);

  console.groupEnd();
  return;
};

// Deposit collateral into the OptimisticDepositBox.
const deposit = async (optimisticDepositBoxAddress, amountOfWethToDeposit) => {
  const collateral = await WETH9.deployed();
  const optimisticDepositBox = await OptimisticDepositBox.at(optimisticDepositBoxAddress);
  const accounts = await web3.eth.getAccounts();

  console.group("4. Depositing ERC20 into the OptimisticDepositBox");
  // Note: The DVM charges a "regular" fee as a % of the deposited collateral every second. However, because the
  // default regular fee is 0, this test setup incurs no periodic fees.
  await optimisticDepositBox.deposit({ rawValue: amountOfWethToDeposit });
  console.log(`- Deposited ${fromWei(amountOfWethToDeposit)} WETH into the OptimisticDepositBox`);

  // Let's check our deposited balance. Note that multiple users can deploy collateral into the same deposit box,
  // but each user (i.e. each address) has its own token balance. So, because we will be depositing collateral
  // for only one user, the "total collateral" in the OptimisticDepositBox will be equal to the user's individual collateral
  // balance.
  const userCollateral = await optimisticDepositBox.getCollateral(accounts[0]);
  const totalCollateral = await optimisticDepositBox.totalOptimisticDepositBoxCollateral();
  const userBalance = await collateral.balanceOf(accounts[0]);

  console.log(`- User's deposit balance: ${fromWei(userCollateral.toString())}`);
  console.log(`- Total deposit balance: ${fromWei(totalCollateral.toString())}`);
  console.log(`- User's WETH balance: ${fromWei(userBalance.toString())}`);

  console.groupEnd();
  return;
};

// Withdraw from OptimisticDepositBox.
const withdraw = async (optimisticDepositBoxAddress, mockPrice, amountOfUsdToWithdraw) => {
  const collateral = await WETH9.deployed();
  const optimisticDepositBox = await OptimisticDepositBox.at(optimisticDepositBoxAddress);
  const accounts = await web3.eth.getAccounts();
  const finder = await Finder.deployed();
  const mockOracle = await MockOracle.at(await finder.getImplementationAddress(utf8ToHex(interfaceName.Oracle)));

  console.group("5. Withdrawing ERC20 from OptimisticDepositBox");

  // Technically, withdrawing is a two step process. First, a request to withdraw must be submitted to the DVM.
  // Next, the DVM voters will resolve and return a price (in production, each voting round takes ~2 days).
  // Once a price is resolved, the user of the OptimisticDepositBox can finalize the withdrawal. However, for test purposes
  // we can "resolve" prices instantaneously by pushing a price (i.e. `mockPrice`) to the MockOracle.

  // Submit a withdrawal request, which sends a price request for the current timestamp to the DVM.
  // The user wants to withdraw a USD-denominated amount of WETH.
  // Note: If the USD amount is greater than the user's deposited balance, the contract will simply withdraw
  // the full user balance.
  // Note-2: The DVM charges a fixed fee on every price request. Therefore, in practice each `requestWithdrawal()` call
  // would incur this fixed fee, which is paid from the deposited collateral pool. However, because the
  // default fee is 0, this test setup incurs no fixed fee.
  const requestTimestamp = await optimisticDepositBox.getCurrentTime();
  await optimisticDepositBox.requestWithdrawal({ rawValue: amountOfUsdToWithdraw });
  console.log(`- Submitted a withdrawal request for ${fromWei(amountOfUsdToWithdraw)} USD of WETH`);

  // Manually push a price to the DVM. This price must be a positive integer.
  await mockOracle.pushPrice(priceFeedIdentifier, requestTimestamp.toNumber(), mockPrice);
  console.log(`- Resolved a price of ${fromWei(mockPrice)} WETH-USD`);

  // Following a price resolution, the user can withdraw their requested USD amount.
  await optimisticDepositBox.executeWithdrawal();

  // Let's check the token balances. At an exchange rate of (1 WETH = $200 USD) and given a requested withdrawal
  // amount of $10,000, the OptimisticDepositBox should have withdrawn ($10,000/$200) 50 WETH.
  const userCollateral = await optimisticDepositBox.getCollateral(accounts[0]);
  const totalCollateral = await optimisticDepositBox.totalOptimisticDepositBoxCollateral();
  const userBalance = await collateral.balanceOf(accounts[0]);

  console.log(`- User's deposit balance: ${fromWei(userCollateral.toString())}`);
  console.log(`- Total deposit balance: ${fromWei(totalCollateral.toString())}`);
  console.log(`- User's WETH balance: ${fromWei(userBalance.toString())}`);

  // Note: the user can cancel their requested withdrawal via the OptimisticDepositBox's `cancelWithdrawal()` method.

  console.groupEnd();
  return;
};

// Main script.
const main = async (callback) => {
  try {
    // Deploy
    const deployedContract = await deploy();
    console.log("\n");

    // Register
    await register(deployedContract);
    console.log("\n");

    // Mint collateral
    const amountOfWethToMint = toWei("1000");
    await setupWallets(deployedContract, amountOfWethToMint);
    console.log("\n");

    // Deposit collateral
    const amountOfWethToDeposit = toWei("200");
    await deposit(deployedContract, amountOfWethToDeposit);
    console.log("\n");

    // Withdraw USD denominated collateteral
    const amountOfUsdToWithdraw = toWei("10000"); // $10,000
    const exchangeRate = toWei("200"); // 1 ETH = $200
    await withdraw(deployedContract, exchangeRate, amountOfUsdToWithdraw);
    console.log("\n");

    // Done!
  } catch (err) {
    console.error(err);
  }
  callback();
};

module.exports = main;
