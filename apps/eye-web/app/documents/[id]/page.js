import { DocumentEditor } from "../../../components/document-editor";

export const metadata = { title: "文書" };

export default async function DocumentPage({ params }) {
  const { id } = await params;
  return <DocumentEditor documentId={id} />;
}
