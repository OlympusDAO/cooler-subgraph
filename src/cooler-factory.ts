import { Address, BigDecimal, BigInt, Bytes, dataSource, ethereum } from "@graphprotocol/graph-ts"
import {
  ClearRequest,
  DefaultLoan,
  RepayLoan,
  RequestLoan,
  RescindRequest,
  ExtendLoan
} from "../generated/CoolerFactory/CoolerFactory"
import { Cooler, Cooler__getLoanResultValue0Struct } from "../generated/CoolerFactory/Cooler"
import { ERC20 } from "../generated/CoolerFactory/ERC20"
import { gOHM } from "../generated/CoolerFactory/gOHM"
import {
  ClaimDefaultedLoanEvent,
  ClearLoanRequestEvent,
  RepayLoanEvent,
  CoolerLoan,
  ExtendLoanEvent,
  CoolerLoanRequest,
  RescindLoanRequestEvent,
} from "../generated/schema"
import { oracles } from "@protofire/subgraph-devkit";
import { toDecimal } from "./numberHelper"
import { getISO8601DateStringFromTimestamp } from "./dateHelper"

const OHM_MAP = new Map<string, string>();
OHM_MAP.set("mainnet", "0x64aa3364F17a4D01c6f1751Fd97C2BD3D7e7f1D5");
OHM_MAP.set("goerli", "0x0595328847AF962F951a4f8F8eE9A3Bf261e4f6b");

const GOHM_MAP = new Map<string, string>();
GOHM_MAP.set("mainnet", "0x0ab87046fBb341D058F17CBC4c1133F25a20a52f");
GOHM_MAP.set("goerli", "0xC1863141dc1861122d5410fB5973951c82871d98");

function getOhmAddress(): Address {
  if (!OHM_MAP.has(dataSource.network())) {
    throw new Error("OHM address not found for network: " + dataSource.network());
  }

  return Address.fromString(OHM_MAP.get(dataSource.network()));
}

function getGOhmAddress(): Address {
  if (!GOHM_MAP.has(dataSource.network())) {
    throw new Error("gOHM address not found for network: " + dataSource.network());
  }

  return Address.fromString(GOHM_MAP.get(dataSource.network()));
}

// === Helpers ===

function getLoanRecordId(cooler: Bytes, loanID: BigInt): string {
  return cooler.toHexString() + "-" + loanID.toString();
}

function getLoanRecord(cooler: Bytes, loanID: BigInt): CoolerLoan | null {
  return CoolerLoan.load(getLoanRecordId(cooler, loanID));
}

function populateLoan(cooler: Cooler, request: CoolerLoanRequest, loanId: BigInt, loanData: Cooler__getLoanResultValue0Struct, block: ethereum.Block, transaction: ethereum.Transaction): CoolerLoan {
  const debtDecimals = ERC20.bind(cooler.debt()).decimals();
  const collateralDecimals = ERC20.bind(cooler.collateral()).decimals();

  const loanRecord: CoolerLoan = new CoolerLoan(getLoanRecordId(cooler._address, loanId));
  loanRecord.createdBlock = block.number;
  loanRecord.createdTimestamp = block.timestamp;
  loanRecord.createdTransaction = transaction.hash;
  loanRecord.loanId = loanId;
  loanRecord.cooler = cooler._address;
  loanRecord.request = request.id;
  loanRecord.borrower = cooler.owner();
  loanRecord.interest = toDecimal(loanData.interestDue, debtDecimals);
  loanRecord.principal = toDecimal(loanData.principal, debtDecimals);
  loanRecord.collateral = toDecimal(loanData.collateral, collateralDecimals);
  loanRecord.expiryTimestamp = loanData.expiry;
  loanRecord.lender = loanData.lender;
  loanRecord.hasCallback = loanData.callback;
  loanRecord.collateralToken = cooler.collateral();
  loanRecord.debtToken = cooler.debt();

  return loanRecord;
}

function getOhmPrice(): BigDecimal {
  return oracles.chainlink.fetchPriceUSD(getOhmAddress());
}

function getGOhmPrice(): BigDecimal {
  // gOHM price is OHM price * index
  const ohmPrice: BigDecimal = getOhmPrice();
  const gOHMContract: gOHM = gOHM.bind(getGOhmAddress());

  return ohmPrice.times(toDecimal(gOHMContract.index(), 9));
}

function getRequestRecordId(cooler: Bytes, requestId: BigInt): string {
  return cooler.toHexString() + "-" + requestId.toString();
}

function getRequestRecord(cooler: Cooler, requestId: BigInt): CoolerLoanRequest | null {
  return CoolerLoanRequest.load(getRequestRecordId(cooler._address, requestId));
}

// === Request handling ===

export function handleRequest(event: RequestLoan): void {
  // Access the Cooler
  const cooler: Cooler = Cooler.bind(event.params.cooler);
  const debtDecimals = ERC20.bind(cooler.debt()).decimals();

  // Get the request information
  const requestId: BigInt = event.params.reqID;
  const request = cooler.getRequest(requestId);

  // Create a new CoolerLoanRequest
  const requestRecord: CoolerLoanRequest = new CoolerLoanRequest(getRequestRecordId(cooler._address, requestId));
  requestRecord.createdBlock = event.block.number;
  requestRecord.createdTimestamp = event.block.timestamp;
  requestRecord.createdTransaction = event.transaction.hash;
  requestRecord.cooler = cooler._address;
  requestRecord.requestId = requestId;
  requestRecord.borrower = cooler.owner();
  requestRecord.collateralToken = cooler.collateral();
  requestRecord.debtToken = cooler.debt();
  requestRecord.amount = toDecimal(request.amount, debtDecimals);

  // Interest rate is stored on the contract in terms of 1e18
  // e.g. request.interest = 5e15 = 0.005
  // We multiply by 100 to get the percentage, e.g. 0.5%
  requestRecord.interestPercentage = toDecimal(request.interest, debtDecimals).times(BigDecimal.fromString("100"));

  requestRecord.loanToCollateralRatio = toDecimal(request.loanToCollateral, debtDecimals);
  requestRecord.durationSeconds = request.duration;
  requestRecord.isRescinded = false;
  requestRecord.save();

  // Create an event record
  const eventRecord: ClearLoanRequestEvent = new ClearLoanRequestEvent(getRequestRecordId(cooler._address, requestId));
  eventRecord.date = getISO8601DateStringFromTimestamp(event.block.timestamp);
  eventRecord.blockNumber = event.block.number;
  eventRecord.blockTimestamp = event.block.timestamp;
  eventRecord.transactionHash = event.transaction.hash;
  eventRecord.request = requestRecord.id;
  eventRecord.save();
}

export function handleRescindRequest(event: RescindRequest): void {
  // Access the Cooler
  const cooler: Cooler = Cooler.bind(event.params.cooler);

  // Get the request
  const requestId = event.params.reqID;
  const requestRecord: CoolerLoanRequest | null = getRequestRecord(cooler, requestId);
  if (requestRecord == null) {
    throw new Error("Request not found with record id: " + getRequestRecordId(cooler._address, requestId));
  }

  // Update the request record
  requestRecord.isRescinded = true;
  requestRecord.save();

  // Create an event record
  const eventRecord: RescindLoanRequestEvent = new RescindLoanRequestEvent(getRequestRecordId(cooler._address, requestId));
  eventRecord.date = getISO8601DateStringFromTimestamp(event.block.timestamp);
  eventRecord.blockNumber = event.block.number;
  eventRecord.blockTimestamp = event.block.timestamp;
  eventRecord.transactionHash = event.transaction.hash;
  eventRecord.request = requestRecord.id;
  eventRecord.save();
}

// === Loan event handling ===

export function handleClearRequest(event: ClearRequest): void {
  // Access the Cooler
  const cooler: Cooler = Cooler.bind(event.params.cooler);

  // Get the loan information
  const loanId: BigInt = event.params.loanID;
  const loanData = cooler.getLoan(loanId);

  // Get the request information
  const requestId: BigInt = event.params.reqID;
  const requestRecord: CoolerLoanRequest | null = getRequestRecord(cooler, requestId);
  if (requestRecord == null) {
    throw new Error("Request not found with record id: " + getLoanRecordId(cooler._address, requestId));
  }

  // Create a new CoolerLoan
  const loanRecord: CoolerLoan = populateLoan(cooler, requestRecord, loanId, loanData, event.block, event.transaction);
  loanRecord.save();

  // Create an event record
  const eventRecord: ClearLoanRequestEvent = new ClearLoanRequestEvent(getLoanRecordId(cooler._address, loanId));
  eventRecord.date = getISO8601DateStringFromTimestamp(event.block.timestamp);
  eventRecord.blockNumber = event.block.number;
  eventRecord.blockTimestamp = event.block.timestamp;
  eventRecord.transactionHash = event.transaction.hash;

  // Loan state
  eventRecord.loan = loanRecord.id;
  eventRecord.request = requestRecord.id;

  eventRecord.save();
}

export function handleDefaultLoan(event: DefaultLoan): void {
  // Access the Cooler
  const cooler: Cooler = Cooler.bind(event.params.cooler);

  // Get the loan information
  const loanId: BigInt = event.params.loanID;
  const loanData = cooler.getLoan(loanId);
  const loanRecord: CoolerLoan | null = getLoanRecord(cooler._address, loanId);
  if (loanRecord == null) {
    throw new Error("Loan not found with record id: " + getLoanRecordId(cooler._address, loanId));
  }

  // Create an event record
  const eventRecord: ClaimDefaultedLoanEvent = new ClaimDefaultedLoanEvent(getLoanRecordId(cooler._address, loanId));
  eventRecord.date = getISO8601DateStringFromTimestamp(event.block.timestamp);
  eventRecord.blockNumber = event.block.number;
  eventRecord.blockTimestamp = event.block.timestamp;
  eventRecord.transactionHash = event.transaction.hash;

  const collateralPrice: BigDecimal = getGOhmPrice();
  const collateralValue: BigDecimal = loanRecord.collateral.times(collateralPrice);

  // Record the amount of collateral that has been claimed
  // The collateral income from the default requires historical data, so it is not calculated here.
  eventRecord.collateralQuantityClaimed = toDecimal(event.params.amount, ERC20.bind(cooler.collateral()).decimals());
  eventRecord.collateralPrice = collateralPrice;
  eventRecord.collateralValueClaimed = collateralValue;

  // Loan state
  eventRecord.loan = loanRecord.id;
  eventRecord.secondsSinceExpiry = event.block.timestamp.minus(loanData.expiry);

  eventRecord.save();
}

export function handleRepayLoan(event: RepayLoan): void {
  // Access the Cooler
  const cooler: Cooler = Cooler.bind(event.params.cooler);

  // Get the loan information
  const loanId: BigInt = event.params.loanID;
  const loanData = cooler.getLoan(loanId);
  const loanRecord: CoolerLoan | null = getLoanRecord(cooler._address, loanId);
  if (loanRecord == null) {
    throw new Error("Loan not found with record id: " + getLoanRecordId(cooler._address, loanId));
  }

  // Create an event record
  const eventRecord: RepayLoanEvent = new RepayLoanEvent(getLoanRecordId(cooler._address, loanId) + "-" + event.block.number.toString());
  eventRecord.date = getISO8601DateStringFromTimestamp(event.block.timestamp);
  eventRecord.blockNumber = event.block.number;
  eventRecord.blockTimestamp = event.block.timestamp;
  eventRecord.transactionHash = event.transaction.hash;

  const debtDecimals = ERC20.bind(cooler.debt()).decimals();

  // Event information
  // The interest income from the repayment requires historical data, so it is not calculated here.
  eventRecord.amountPaid = toDecimal(event.params.amount, debtDecimals);

  // Loan state
  eventRecord.loan = loanRecord.id;
  eventRecord.secondsToExpiry = loanData.expiry.minus(event.block.timestamp);
  eventRecord.principalPayable = toDecimal(loanData.principal, debtDecimals);
  eventRecord.interestPayable = toDecimal(loanData.interestDue, debtDecimals);
  eventRecord.collateralDeposited = toDecimal(loanData.collateral, ERC20.bind(cooler.collateral()).decimals());

  eventRecord.save();
}

export function handleExtendLoan(event: ExtendLoan): void {
  // Access the Cooler
  const cooler: Cooler = Cooler.bind(event.params.cooler);

  // Get the loan information
  const loanId: BigInt = event.params.loanID;
  const loanData = cooler.getLoan(loanId);
  const loanRecord: CoolerLoan | null = getLoanRecord(cooler._address, loanId);
  if (loanRecord == null) {
    throw new Error("Loan not found with record id: " + getLoanRecordId(cooler._address, loanId));
  }

  // Create the event record
  const eventRecord: ExtendLoanEvent = new ExtendLoanEvent(getLoanRecordId(cooler._address, loanId) + "-" + event.block.number.toString());
  eventRecord.date = getISO8601DateStringFromTimestamp(event.block.timestamp);
  eventRecord.blockNumber = event.block.number;
  eventRecord.blockTimestamp = event.block.timestamp;
  eventRecord.transactionHash = event.transaction.hash;

  // Event information
  eventRecord.periods = event.params.times;

  // Loan state
  eventRecord.loan = loanRecord.id;
  eventRecord.expiryTimestamp = loanData.expiry;
  eventRecord.interestDue = toDecimal(loanData.interestDue, ERC20.bind(cooler.debt()).decimals());

  eventRecord.save();
}
