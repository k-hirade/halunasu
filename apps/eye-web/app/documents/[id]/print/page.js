import { DocumentPrint } from "../../../../components/document-print";

export default async function DocumentPrintPage({ params }) {
  const { id } = await params;
  return <DocumentPrint documentId={id} />;
}
