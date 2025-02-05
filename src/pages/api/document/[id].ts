import type { NextApiRequest, NextApiResponse } from 'next';
import { db } from '@/server/db';
import { authenticateUser } from '@/server/auth';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

// Plate.js types
interface PlateText {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  [key: string]: any; // For other formatting marks
}

interface PlateElement {
  type: string;
  children: (PlateElement | PlateText)[];
  [key: string]: any; // For other element attributes
}

interface PlateDocument {
  type: 'doc';
  content: PlateElement[];
}

// Validation schemas
const plateTextSchema: z.ZodType<PlateText> = z.object({
  text: z.string(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
}).passthrough(); // Allow other formatting marks

const plateElementSchema: z.ZodType<PlateElement> = z.lazy(() => 
  z.object({
    type: z.string(),
    children: z.array(z.union([plateElementSchema, plateTextSchema])),
  }).passthrough() // Allow other element attributes
);

const plateDocumentSchema: z.ZodType<PlateDocument> = z.object({
  type: z.literal('doc'),
  content: z.array(plateElementSchema),
});

const updateDocumentSchema = z.object({
  title: z.string().optional(),
  icon: z.union([
    z.string().refine(
      (str) => {
        const emojiRegex = /^(?:[\u2700-\u27bf]|(?:\ud83c[\udde6-\uddff]){2}|[\ud800-\udbff][\udc00-\udfff]|[\u0023-\u0039]\ufe0f?\u20e3|\u3299|\u3297|\u303d|\u3030|\u24c2|\ud83c[\udd70-\udd71]|\ud83c[\udd7e-\udd7f]|\ud83c\udd8e|\ud83c[\udd91-\udd9a]|\ud83c[\udde6-\uddff]|\ud83c[\ude01-\ude02]|\ud83c\ude1a|\ud83c\ude2f|\ud83c[\ude32-\ude3a]|\ud83c[\ude50-\ude51]|\u203c|\u2049|[\u25aa-\u25ab]|\u25b6|\u25c0|[\u25fb-\u25fe]|\u00a9|\u00ae|\u2122|\u2139|\ud83c\udc04|[\u2600-\u26FF]|\u2b05|\u2b06|\u2b07|\u2b1b|\u2b1c|\u2b50|\u2b55|\u231a|\u231b|\u2328|\u23cf|[\u23e9-\u23f3]|[\u23f8-\u23fa]|\ud83c\udccf|\u2934|\u2935|[\u2190-\u21ff])$/;
        return emojiRegex.test(str);
      },
      'Must be a single emoji character'
    ),
    z.string().url('Must be a valid URL'),
    z.null()
  ]).nullable().optional(),
  coverImage: z.union([
    z.string().regex(/^linear-gradient\(.*\)$/, 'Must be a valid CSS gradient'),
    z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex color'),
    z.string().url('Must be a valid URL'),
    z.null()
  ]).nullable().optional(),
  content: plateDocumentSchema.optional(),
  position: z.object({
    x: z.number().finite().min(0).max(10000),
    y: z.number().finite().min(0).max(10000)
  }).optional()
});

// Validation helper
function validatePlateContent(content: unknown): content is PlateDocument {
  const validateElement = (element: unknown): boolean => {
    if (element && typeof element === 'object' && 'text' in element) {
      return typeof (element as PlateText).text === 'string';
    }
    
    if (
      element && 
      typeof element === 'object' && 
      'type' in element && 
      'children' in element
    ) {
      const elem = element as PlateElement;
      return typeof elem.type === 'string' && 
             Array.isArray(elem.children) &&
             elem.children.every(child => validateElement(child));
    }
    
    return false;
  };

  if (
    !content || 
    typeof content !== 'object' || 
    !('type' in content) || 
    !('content' in content) || 
    (content as PlateDocument).type !== 'doc' || 
    !Array.isArray((content as PlateDocument).content)
  ) {
    return false;
  }

  return (content as PlateDocument).content.every(element => validateElement(element));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  console.log('[DEBUG] Document request received:', {
    method: req.method,
    documentId: req.query.id,
    headers: req.headers,
    timestamp: new Date().toISOString()
  });

  try {
    // Check if Authorization header exists
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ 
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
        message: 'No authorization header provided'
      });
    }

    // Check Bearer token format
    const token = authHeader.split(' ')[1];
    if (!token || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Invalid authentication format',
        code: 'INVALID_AUTH_FORMAT',
        message: 'Authorization header must use Bearer scheme'
      });
    }

    console.log('[DEBUG] Token:', 'Present');
    
    try {
      const userId = await authenticateUser(token);
      console.log('[DEBUG] User authenticated:', userId);
      
      const documentId = req.query.id as string;
      console.log('[DEBUG] Looking up document:', documentId);
      
      switch (req.method) {
        case 'GET':
          return handleGet(documentId, userId, res);
        case 'PUT':
          return handleUpdate(documentId, userId, req.body, res);
        case 'DELETE':
          return handleDelete(documentId, userId, res);
        default:
          return res.status(405).json({ error: 'Method not allowed' });
      }
    } catch (authError) {
      if (authError instanceof Error) {
        if (authError.message === 'Token expired') {
          return res.status(401).json({
            error: 'Token expired',
            code: 'TOKEN_EXPIRED',
            message: 'Authentication token has expired'
          });
        }
        if (authError.message === 'Invalid token') {
          return res.status(401).json({
            error: 'Invalid token',
            code: 'INVALID_TOKEN',
            message: 'Authentication token is invalid'
          });
        }
      }
      return res.status(401).json({
        error: 'Authentication failed',
        code: 'AUTH_FAILED',
        message: 'Failed to authenticate user'
      });
    }
  } catch (err: unknown) {
    console.error('Error handling document request:', {
      error: err instanceof Error ? err.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(documentId: string, userId: string, res: NextApiResponse) {
  try {
    console.log('Fetching document:', {
      documentId,
      userId,
      timestamp: new Date().toISOString()
    });

    const document = await db.document.findFirst({
      where: {
        id: documentId,
        users: {
          some: {
            id: userId,
          },
        },
      },
      include: {
        users: {
          select: {
            id: true,
            name: true,
          },
        },
        versions: {
          orderBy: {
            createdAt: 'desc',
          },
          take: 1,
          select: {
            id: true,
            content: true,
            createdAt: true,
          },
        },
      },
    });

    if (!document) {
      // Check if document exists but user doesn't have access
      const documentExists = await db.document.findUnique({
        where: { id: documentId },
        select: { id: true }
      });

      if (documentExists) {
        return res.status(403).json({
          error: 'Access denied',
          code: 'ACCESS_DENIED',
          message: 'You do not have permission to access this document'
        });
      }

      return res.status(404).json({
        error: 'Document not found',
        code: 'DOCUMENT_NOT_FOUND',
        message: 'The requested document does not exist'
      });
    }

    // Ensure position is properly formatted
    const position = document.position as { x: number; y: number };
    if (!position || typeof position.x !== 'number' || typeof position.y !== 'number') {
      document.position = { x: 0, y: 0 };
    }

    // Ensure we're returning the actual content from the document
    const response = {
      ...document,
      content: document.content || {
        type: 'doc',
        content: [{ type: 'p', children: [{ text: '' }] }]
      },
      position: position || { x: 0, y: 0 }
    };

    console.log('Sending document response:', {
      documentId,
      hasContent: !!response.content,
      position: response.position,
      timestamp: new Date().toISOString()
    });

    return res.status(200).json(response);
  } catch (error) {
    console.error('Error fetching document:', {
      documentId,
      userId,
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : 'Unknown error',
      timestamp: new Date().toISOString()
    });
    return res.status(500).json({ error: 'Failed to fetch document' });
  }
}

async function handleUpdate(
  documentId: string,
  userId: string,
  body: any,
  res: NextApiResponse
) {
  try {
    // Validate input
    const validatedInput = updateDocumentSchema.parse(body);

    // Check if user has access to the document
    const existingDocument = await db.document.findFirst({
      where: {
        id: documentId,
        users: {
          some: {
            id: userId
          }
        }
      }
    });

    if (!existingDocument) {
      return res.status(404).json({
        error: 'Document not found',
        code: 'DOCUMENT_NOT_FOUND',
        message: 'Document not found or you do not have permission to update it'
      });
    }

    // Prepare update data
    const updateData: any = {};
    if (validatedInput.title !== undefined) updateData.title = validatedInput.title;
    if (validatedInput.icon !== undefined) updateData.icon = validatedInput.icon;
    if (validatedInput.coverImage !== undefined) updateData.coverImage = validatedInput.coverImage;
    if (validatedInput.position !== undefined) updateData.position = validatedInput.position;
    if (validatedInput.content !== undefined) {
      updateData.content = validatedInput.content as unknown as Prisma.InputJsonValue;
      // Create a new version when content changes
      await db.version.create({
        data: {
          content: validatedInput.content as unknown as Prisma.InputJsonValue,
          documentId: documentId,
          userId: userId
        }
      });
    }

    // Update the document
    const updatedDocument = await db.document.update({
      where: { id: documentId },
      data: updateData,
      include: {
        users: {
          select: {
            id: true,
            name: true
          }
        },
        versions: {
          orderBy: {
            createdAt: 'desc'
          },
          take: 1,
          select: {
            id: true,
            content: true,
            createdAt: true,
            userId: true,
            user: {
              select: {
                id: true,
                name: true
              }
            }
          }
        }
      }
    });

    return res.status(200).json(updatedDocument);
  } catch (error) {
    console.error('Error updating document:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Invalid input',
        code: 'INVALID_INPUT',
        message: 'The provided input is invalid',
        details: error.errors
      });
    }
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred while updating the document'
    });
  }
}

async function handleDelete(documentId: string, userId: string, res: NextApiResponse) {
  try {
    console.log('Attempting to delete document:', {
      documentId,
      userId,
      timestamp: new Date().toISOString()
    });

    // Check document access
    const document = await db.document.findFirst({
      where: {
        id: documentId,
        users: {
          some: {
            id: userId,
          },
        },
      },
      include: {
        users: true,
        versions: {
          select: {
            id: true
          }
        }
      }
    });

    if (!document) {
      // Check if document exists but user doesn't have access
      const documentExists = await db.document.findUnique({
        where: { id: documentId },
        select: { id: true }
      });

      if (documentExists) {
        return res.status(403).json({
          error: 'Access denied',
          code: 'ACCESS_DENIED',
          message: 'You do not have permission to delete this document'
        });
      }

      return res.status(404).json({
        error: 'Document not found',
        code: 'DOCUMENT_NOT_FOUND',
        message: 'The requested document does not exist'
      });
    }

    // First, delete all relationships
    await db.$transaction([
      // Delete user relationships
      db.document.update({
        where: { id: documentId },
        data: {
          users: {
            disconnect: document.users.map(user => ({ id: user.id }))
          }
        }
      }),
      // Delete versions
      db.version.deleteMany({
        where: { documentId }
      }),
      // Finally, delete the document
      db.document.delete({
        where: { id: documentId }
      })
    ]);

    console.log('Document deleted successfully:', {
      documentId,
      userId,
      timestamp: new Date().toISOString()
    });

    return res.status(204).end();
  } catch (error) {
    console.error('Error deleting document:', {
      documentId,
      userId,
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : 'Unknown error',
      timestamp: new Date().toISOString()
    });

    // Check for specific Prisma errors
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        return res.status(404).json({
          error: 'Document not found',
          code: 'DOCUMENT_NOT_FOUND',
          message: 'The requested document does not exist'
        });
      }
      if (error.code === 'P2003') {
        return res.status(400).json({
          error: 'Document in use',
          code: 'DOCUMENT_IN_USE',
          message: 'Cannot delete document due to existing references'
        });
      }
    }

    return res.status(500).json({ error: 'Failed to delete document' });
  }
} 