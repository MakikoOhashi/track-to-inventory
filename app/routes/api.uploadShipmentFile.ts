import formidable, { File, Fields, Files } from 'formidable';
import { createClient } from '@supabase/supabase-js';
import type { NextApiRequest, NextApiResponse } from 'next';

export const config = {
  api: { bodyParser: false },
};

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const form = new formidable.IncomingForm();
  form.parse(req, async (err: any, fields: Fields, files: Files) => {
    if (err) return res.status(500).json({ error: 'Form parse error' });

    const si_number = Array.isArray(fields.si_number) ? fields.si_number[0] : fields.si_number;
    const type = Array.isArray(fields.type) ? fields.type[0] : fields.type;
    const file = Array.isArray(files.file) ? files.file[0] : files.file;

    if (!si_number || !type || !file) {
      return res.status(400).json({ error: 'missing fields' });
    }

    const originalFilename = (file as File).originalFilename || '';
    const fileExt = originalFilename.split('.').pop();
    const filePath = `${si_number}/${type}.${fileExt}`;

    const { error: uploadError } = await supabase.storage
      .from('shipment-files')
      .upload(filePath, file.filepath, { upsert: true });

    if (uploadError) {
      return res.status(500).json({ error: uploadError.message });
    }

    const { data } = supabase.storage
      .from('shipment-files')
      .getPublicUrl(filePath);

    return res.status(200).json({ publicUrl: data.publicUrl });
  });
}