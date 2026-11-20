import { DocumentPrint } from "../../../../components/document-print";

export const metadata = { title: "文書の印刷" };

export default async function DocumentPrintPage({ params }) {
  const { id } = await params;
  return <DocumentPrint documentId={id} />;
}
