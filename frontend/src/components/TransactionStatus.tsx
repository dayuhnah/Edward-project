
export type TransactionStage =
  | "idle"
  | "wallet"
  | "pending"
  | "success"
  | "failed"
  | "unknown";

export type TransactionInfo = {
  stage: TransactionStage;
  hash?: string;
  detail?: string;
};

const statusText = {
  wallet: {
    title: "Waiting for MetaMask",
    description: "Please approve the transaction in your wallet.",
  },
  pending: {
    title: "Transaction submitted",
    description: "Waiting for blockchain confirmation...",
  },
  success: {
    title: "Purchase successful!",
    description: "Your transaction has been confirmed.",
  },
  failed: {
    title: "Transaction not completed",
    description: "The transaction was cancelled or failed.",
  },
  unknown: {
    title: "Confirmation not verified",
    description:
      "Check the transaction before trying again.",
  },
};

export default function TransactionStatus({
  stage,
  hash,
  detail,
}: TransactionInfo) {
  if (stage === "idle") return null;

  const status = statusText[stage];

  return (
    <div
      className={`transaction-status transaction-${stage}`}
      role={stage === "failed" ? "alert" : "status"}
    >
      <strong>{status.title}</strong>

      <p>{detail || status.description}</p>

      {hash && (
        <div className="transaction-hash">
          <small>Transaction hash:</small>
          <code>{hash}</code>
        </div>
      )}
    </div>
  );
}
